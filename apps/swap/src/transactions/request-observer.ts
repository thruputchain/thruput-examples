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
import { createReadClient, getValidatedChainTip } from "@/groundhog/client";
import type { OutstandingRequest } from "@/transactions/outstanding-request";

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

export interface RequestObserver {
  scan(request: OutstandingRequest): Promise<{
    result: RequestObservation | null;
    latestBlock: bigint;
  }>;
}

export function createRequestObserver(
  config: AppConfig,
  client: Pick<
    GroundhogClient,
    "getBlockByNumber" | "getChainTip" | "getEvents"
  > = createReadClient(config),
): RequestObserver {
  return {
    async scan(request) {
      if (request.requestId === null || request.receiptBlock === null) {
        throw new Error("Queued request is missing its request ID or receipt block");
      }
      await getValidatedChainTip(client, config.networkId);
      const requestId = requestIdFromHex(request.requestId);
      const pairAddress = addressFromHex(request.criteria.pairAddress);
      const handlerAddress = addressFromHex(request.criteria.handlerAddress);
      const driverAddress = addressFromHex(request.criteria.driverAddress);
      const recipient = addressFromHex(request.criteria.recipient);
      const filters = [
        {
          contractAddresses: [pairAddress],
          topics: {
            topic0: [SWAP_EVENT_SIGNATURE],
            topic1: [handlerAddress],
            topic2: [recipient],
          },
        },
        {
          contractAddresses: [driverAddress],
          topics: {
            topic0: [REQUEST_FAILED_SIGNATURE],
            topic1: [requestId],
          },
        },
      ];
      const seenEvents = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: Uint8Array | undefined;
      let latestBlock = request.receiptBlock;
      let historyUnavailable = false;

      for (;;) {
        const page: EventPage = await client.getEvents({
          filters,
          order: "ascending",
          anchor: { height: request.receiptBlock },
          ...(cursor === undefined ? {} : { cursor }),
          limit: 200,
        });
        if (page.latestBlock > latestBlock) latestBlock = page.latestBlock;
        if (page.oldestBlock > request.receiptBlock) {
          historyUnavailable = true;
        }

        for (const event of page.events) {
          const key = `${toHex0x(event.txHash)}:${event.sequenceNumber}`;
          if (seenEvents.has(key)) continue;
          seenEvents.add(key);
          const result = matchTerminalEvent(request, requestId, event);
          if (result !== null) return { result, latestBlock };
        }

        if (page.cursor.length === 0) {
          if (historyUnavailable) {
            throw new Error("Event history no longer covers the enqueue block");
          }
          return { result: null, latestBlock };
        }
        const cursorKey = toHex0x(page.cursor);
        if (seenCursors.has(cursorKey)) {
          throw new Error("Event query returned a repeated pagination cursor");
        }
        seenCursors.add(cursorKey);
        cursor = page.cursor;
      }
    },
  };
}

function matchTerminalEvent(
  request: OutstandingRequest,
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
