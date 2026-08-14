import {
  addressFromHex,
  toHex0x,
  type EventPage,
  type GroundhogClient,
  type IdentifiedEvent,
} from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import {
  bytesEqual,
  decodeRequestFailed,
  decodeSwapEvent,
  REQUEST_FAILED_SIGNATURE,
  SWAP_EVENT_SIGNATURE,
} from "@/contracts/swap-event";
import { orderTokens } from "@/domain/tokens";
import { createReadClient } from "@/groundhog/client";
import type { OutstandingRequest } from "@/transactions/outstanding-request";
import type { RequestRecord } from "@/transactions/request-collection";

export type RequestObservation =
  | {
      kind: "executionObserved";
      requestId: string;
      transactionHash: string;
      blockHeight: bigint;
      amountIn: bigint;
      amountOut: bigint;
    }
  | {
      kind: "executionFailed";
      requestId: string;
      transactionHash: string;
      blockHeight: bigint;
    }
  | {
      kind: "executionInferred";
      requestId: string;
      transactionHash: string;
      blockHeight: bigint;
      amountIn: bigint;
      amountOut: bigint;
    };

type ObservableRequest = Omit<OutstandingRequest, "status"> & {
  status?: OutstandingRequest["status"] | RequestRecord["status"];
};

export interface RequestObserver {
  scan(request: ObservableRequest): Promise<RequestObservation | null>;
  scanAll?: (
    requests: readonly RequestRecord[],
  ) => Promise<RequestObservationBatch>;
}

export interface RequestObservationBatch {
  observations: RequestObservation[];
  observedThroughBlock: bigint | null;
}

export function createRequestObserver(
  config: AppConfig,
  client: Pick<GroundhogClient, "getEvents"> = createReadClient(config),
): RequestObserver {
  const scanAll = async (
    requests: readonly RequestRecord[],
  ): Promise<RequestObservationBatch> => {
    if (requests.length === 0) {
      return { observations: [], observedThroughBlock: null };
    }

    const requestsById = new Map<string, RequestRecord>();
    for (const request of requests) {
      if (request.requestId === null || request.receiptBlock === null) {
        throw new Error("Queued request is missing its request ID or receipt block");
      }
      if (requestsById.has(request.requestId)) {
        throw new Error("Queued requests contain a duplicate request ID");
      }
      requestsById.set(request.requestId, request);
    }

    const anchorHeight = requests.reduce(
      (earliest, request) => {
        const start = request.observedThroughBlock ?? request.receiptBlock!;
        return start < earliest ? start : earliest;
      },
      requests[0]!.observedThroughBlock ?? requests[0]!.receiptBlock!,
    );
    const requestIds = [...requestsById.keys()].map(requestIdFromHex);
    const filters = [
      {
        contractAddresses: [config.pairAddress],
        topics: {
          topic0: [SWAP_EVENT_SIGNATURE],
          topic1: [config.handlerAddress],
          topic2: [config.accountAddress],
        },
      },
      {
        contractAddresses: [config.driverAddress],
        topics: {
          topic0: [REQUEST_FAILED_SIGNATURE],
          topic1: requestIds,
        },
      },
    ];
    const observations: RequestObservation[] = [];
    const completed = new Set<string>();
    const seenEvents = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: Uint8Array | undefined;
    let observedThroughBlock: bigint | null = null;
    let oldestRetainedBlock: bigint | null = null;

    for (;;) {
      const page: EventPage = await client.getEvents({
        filters,
        order: "ascending",
        anchor: { height: anchorHeight },
        ...(cursor === undefined ? {} : { cursor }),
        limit: 200,
      });
      observedThroughBlock = observedThroughBlock === null
          || page.latestBlock > observedThroughBlock
        ? page.latestBlock
        : observedThroughBlock;
      oldestRetainedBlock = oldestRetainedBlock === null
          || page.oldestBlock > oldestRetainedBlock
        ? page.oldestBlock
        : oldestRetainedBlock;

      for (const event of page.events) {
        const key = `${toHex0x(event.txHash)}:${event.sequenceNumber}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);

        const requestId = terminalRequestId(event, config);
        if (requestId === null || completed.has(requestId)) continue;
        const request = requestsById.get(requestId);
        if (request === undefined) continue;
        const observation = matchTerminalEvent(
          request,
          requestIdFromHex(requestId),
          event,
        );
        if (observation !== null) {
          observations.push(observation);
          completed.add(requestId);
        }
      }

      if (page.cursor.length === 0) break;
      const cursorKey = toHex0x(page.cursor);
      if (seenCursors.has(cursorKey)) {
        throw new Error("Event query returned a repeated pagination cursor");
      }
      seenCursors.add(cursorKey);
      cursor = page.cursor;
    }

    if (
      oldestRetainedBlock !== null
      && requests.some((request) => {
        if (completed.has(request.requestId!)) return false;
        const requiredFrom = request.observedThroughBlock === null
          ? request.receiptBlock!
          : request.observedThroughBlock + 1n;
        return oldestRetainedBlock! > requiredFrom;
      })
    ) {
      throw new Error("Event history no longer covers an unresolved request");
    }

    return { observations, observedThroughBlock };
  };

  return {
    async scan(request) {
      const compatible: RequestRecord = {
        ...request,
        status: request.status ?? "queued",
        localId: "single-request-scan",
        createdAt: 0,
        updatedAt: 0,
        observedThroughBlock: null,
        snapshotInferenceEligible: request.observationBaseline !== null,
        execution: null,
      };
      const batch = await scanAll([compatible]);
      return batch.observations[0] ?? null;
    },
    scanAll,
  };
}

export function applyObservationBatch(
  current: readonly RequestRecord[],
  scanned: readonly RequestRecord[],
  batch: RequestObservationBatch,
  now = Date.now(),
): RequestRecord[] {
  const scannedIds = new Set(
    scanned.flatMap(({ requestId }) => requestId === null ? [] : [requestId]),
  );
  const observations = new Map(
    batch.observations.map((observation) => [observation.requestId, observation]),
  );

  return current.map((request) => {
    if (
      request.requestId === null
      || !scannedIds.has(request.requestId)
      || request.status === "executed"
      || request.status === "failed"
    ) return request;

    const observation = observations.get(request.requestId);
    if (observation?.kind === "executionFailed") {
      return {
        ...request,
        status: "failed",
        updatedAt: now,
        observedThroughBlock: batch.observedThroughBlock,
        execution: {
          kind: "failed",
          transactionHash: observation.transactionHash,
          blockHeight: observation.blockHeight,
        },
      };
    }
    if (
      observation?.kind === "executionObserved"
      || observation?.kind === "executionInferred"
    ) {
      return {
        ...request,
        status: "executed",
        updatedAt: now,
        observedThroughBlock: batch.observedThroughBlock,
        execution: {
          kind: "executed",
          transactionHash: observation.transactionHash,
          blockHeight: observation.blockHeight,
          amountIn: observation.amountIn,
          amountOut: observation.amountOut,
        },
      };
    }
    if (batch.observedThroughBlock === null) return request;
    return {
      ...request,
      observedThroughBlock: request.observedThroughBlock === null
          || batch.observedThroughBlock > request.observedThroughBlock
        ? batch.observedThroughBlock
        : request.observedThroughBlock,
    };
  });
}

function terminalRequestId(
  identified: IdentifiedEvent,
  config: AppConfig,
): string | null {
  if (bytesEqual(identified.event.contractAddress, config.driverAddress)) {
    const requestId = decodeRequestFailed(identified.event);
    return requestId === null ? null : toHex0x(requestId);
  }
  if (!bytesEqual(identified.event.contractAddress, config.pairAddress)) return null;
  const swap = decodeSwapEvent(identified.event);
  return swap?.requestId === null || swap?.requestId === undefined
    ? null
    : toHex0x(swap.requestId);
}

function matchTerminalEvent(
  request: ObservableRequest,
  requestId: Uint8Array,
  identified: IdentifiedEvent,
): RequestObservation | null {
  if (identified.blockHeight < request.receiptBlock!) return null;
  const event = identified.event;
  const pairAddress = addressFromHex(request.criteria.pairAddress);
  const handlerAddress = addressFromHex(request.criteria.handlerAddress);
  const driverAddress = addressFromHex(request.criteria.driverAddress);
  const recipient = addressFromHex(request.criteria.recipient);

  if (bytesEqual(event.contractAddress, driverAddress)) {
    const failedId = decodeRequestFailed(event);
    if (failedId === null || !bytesEqual(failedId, requestId)) return null;
    return {
      kind: "executionFailed",
      requestId: request.requestId!,
      transactionHash: toHex0x(identified.txHash),
      blockHeight: identified.blockHeight,
    };
  }

  if (!bytesEqual(event.contractAddress, pairAddress)) return null;
  const swap = decodeSwapEvent(event);
  if (
    swap === null
    || swap.requestId === null
    || !bytesEqual(swap.requestId, requestId)
    || !bytesEqual(swap.sender, handlerAddress)
    || !bytesEqual(swap.recipient, recipient)
  ) return null;

  const inputIndex = orderTokens(
    addressFromHex(request.criteria.tokenIn),
    addressFromHex(request.criteria.tokenOut),
  ).inputIndex;
  const outputIndex = inputIndex === 0 ? 1 : 0;
  if (
    swap.amountsIn[inputIndex] !== request.intent.amountIn
    || swap.amountsIn[outputIndex] !== 0n
    || swap.amountsOut[inputIndex] !== 0n
    || swap.amountsOut[outputIndex] < request.intent.amountOutMin
    || swap.amountsOut[outputIndex] <= 0n
  ) return null;

  return {
    kind: "executionObserved",
    requestId: request.requestId!,
    transactionHash: toHex0x(identified.txHash),
    blockHeight: identified.blockHeight,
    amountIn: swap.amountsIn[inputIndex],
    amountOut: swap.amountsOut[outputIndex],
  };
}

function requestIdFromHex(value: string): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error("Request ID must be a lowercase 32-byte hexadecimal value");
  }
  return addressFromHex(value);
}
