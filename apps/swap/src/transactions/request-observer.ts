import {
  addressFromHex,
  bytesEqual,
  fixedBytes,
  fromHex0x,
  toHex0x,
  type EventPage,
  type FixedBytes,
  type GroundhogClient,
  type IdentifiedEvent,
  type TransactionReceipt,
} from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import { requestFailureMessage } from "@/contracts/failure-message";
import { RequestFailed } from "@/contracts/generated/swap-driver";
import {
  SwapEvent as GeneratedSwapEvent,
  type SwapEvent,
} from "@/contracts/generated/swap-handler";
import { orderTokens } from "@/domain/tokens";
import { createReadClient } from "@/groundhog/client";
import type { OutstandingRequest } from "@/transactions/request-collection";
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
      failureMessage?: string;
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
    const filters = [
      GeneratedSwapEvent.filter({
        contractAddresses: [config.handlerAddress],
      }),
      RequestFailed.filter({
        contractAddresses: [config.driverAddress],
      }),
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
        observedThroughBlock:
          batch.observedThroughBlock ?? request.observedThroughBlock,
        execution: {
          kind: "failed",
          ...(observation.failureMessage === undefined
            ? {}
            : { failureMessage: observation.failureMessage }),
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
        observedThroughBlock:
          batch.observedThroughBlock ?? request.observedThroughBlock,
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

export function observationsFromReceipt(
  config: AppConfig,
  requests: readonly RequestRecord[],
  receipt: TransactionReceipt,
): RequestObservationBatch {
  const requestsById = new Map(
    requests.flatMap((request) =>
      request.requestId === null ? [] : [[request.requestId, request] as const]
    ),
  );
  const observations: RequestObservation[] = [];
  const completed = new Set<string>();

  const addObservation = (
    requestId: string,
    observation: RequestObservation | null,
  ) => {
    if (observation === null) return;
    if (completed.has(requestId)) {
      throw new Error(
        "Crank receipt contains duplicate terminal request events",
      );
    }
    completed.add(requestId);
    observations.push(observation);
  };

  for (const decoded of GeneratedSwapEvent.allFromReceipt(receipt, {
    contractAddress: config.handlerAddress,
  })) {
    const requestBytes = decoded.fields.request_id;
    if (requestBytes === null) continue;
    const requestId = toHex0x(requestBytes);
    const request = requestsById.get(requestId);
    if (request === undefined) continue;
    addObservation(
      requestId,
      matchSwapEvent(
        request,
        requestIdFromHex(requestId),
        decoded,
        receipt.txHash,
        receipt.height,
      ),
    );
  }

  for (const failed of RequestFailed.allFromReceipt(receipt, {
    contractAddress: config.driverAddress,
  })) {
    const requestId = toHex0x(failed.topics.request_id);
    const request = requestsById.get(requestId);
    if (request === undefined) continue;
    addObservation(
      requestId,
      matchFailedEvent(
        request,
        requestIdFromHex(requestId),
        failed,
        receipt.txHash,
        receipt.height,
      ),
    );
  }

  return { observations, observedThroughBlock: null };
}

function terminalRequestId(
  identified: IdentifiedEvent,
  config: AppConfig,
): string | null {
  if (bytesEqual(identified.event.contractAddress, config.driverAddress)) {
    const failed = RequestFailed.decode(identified.event);
    return failed === null ? null : toHex0x(failed.topics.request_id);
  }
  if (!bytesEqual(identified.event.contractAddress, config.handlerAddress))
    return null;
  const swap = GeneratedSwapEvent.decode(identified.event);
  return swap?.fields.request_id === null ||
    swap?.fields.request_id === undefined
    ? null
    : toHex0x(swap.fields.request_id);
}

function matchTerminalEvent(
  request: ObservableRequest,
  requestId: Uint8Array,
  identified: IdentifiedEvent,
): RequestObservation | null {
  if (identified.blockHeight < request.receiptBlock!) return null;
  const event = identified.event;
  const handlerAddress = addressFromHex(request.criteria.handlerAddress);
  const driverAddress = addressFromHex(request.criteria.driverAddress);

  if (bytesEqual(event.contractAddress, driverAddress)) {
    const failed = RequestFailed.decode(event);
    return failed === null
      ? null
      : matchFailedEvent(
          request,
          requestId,
          failed,
          identified.txHash,
          identified.blockHeight,
        );
  }

  if (!bytesEqual(event.contractAddress, handlerAddress)) return null;
  const swap = GeneratedSwapEvent.decode(event);
  return swap === null
    ? null
    : matchSwapEvent(
        request,
        requestId,
        swap,
        identified.txHash,
        identified.blockHeight,
      );
}

function matchFailedEvent(
  request: ObservableRequest,
  requestId: Uint8Array,
  failed: RequestFailed,
  txHash: Uint8Array,
  blockHeight: bigint,
): RequestObservation | null {
  if (
    blockHeight < request.receiptBlock!
    || !bytesEqual(failed.topics.request_id, requestId)
  ) {
    return null;
  }
  const failureMessage = requestFailureMessage(failed.fields);
  return {
    kind: "executionFailed",
    ...(failureMessage === null ? {} : { failureMessage }),
    requestId: request.requestId!,
    transactionHash: toHex0x(txHash),
    blockHeight,
  };
}

function matchSwapEvent(
  request: ObservableRequest,
  requestId: Uint8Array,
  swap: SwapEvent,
  txHash: Uint8Array,
  blockHeight: bigint,
): RequestObservation | null {
  if (blockHeight < request.receiptBlock!) return null;
  const sender = addressFromHex(request.criteria.sender);
  const recipient = addressFromHex(request.criteria.recipient);
  if (
    swap.fields.request_id === null ||
    !bytesEqual(swap.fields.request_id, requestId) ||
    !bytesEqual(swap.topics.sender, sender) ||
    !bytesEqual(swap.topics.recipient, recipient)
  )
    return null;

  const inputIndex = orderTokens(
    addressFromHex(request.criteria.tokenIn),
    addressFromHex(request.criteria.tokenOut),
  ).inputIndex;
  const outputIndex = inputIndex === 0 ? 1 : 0;
  if (
    swap.fields.amounts_in[inputIndex] !== request.intent.amountIn ||
    swap.fields.amounts_in[outputIndex] !== 0n ||
    swap.fields.amounts_out[inputIndex] !== 0n ||
    swap.fields.amounts_out[outputIndex] < request.intent.amountOutMin ||
    swap.fields.amounts_out[outputIndex] <= 0n
  )
    return null;

  return {
    kind: "executionObserved",
    requestId: request.requestId!,
    transactionHash: toHex0x(txHash),
    blockHeight,
    amountIn: swap.fields.amounts_in[inputIndex],
    amountOut: swap.fields.amounts_out[outputIndex],
  };
}

function requestIdFromHex(value: string): FixedBytes<32> {
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error("Request ID must be a lowercase 32-byte hexadecimal value");
  }
  return fixedBytes(fromHex0x(value), 32);
}
