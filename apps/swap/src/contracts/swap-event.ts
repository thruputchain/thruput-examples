import type { TransactionReceipt } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import {
  RequestAccepted,
  RequestFailed,
} from "@/contracts/generated/swap-driver";
import { SwapEvent as GeneratedSwapEvent } from "@/contracts/generated/swap-pair";

export const SWAP_EVENT_SIGNATURE = GeneratedSwapEvent.signature;
export const REQUEST_ACCEPTED_SIGNATURE = RequestAccepted.signature;
export const REQUEST_FAILED_SIGNATURE = RequestFailed.signature;

export interface SwapEvent {
  sender: Uint8Array;
  recipient: Uint8Array;
  amountsIn: readonly [bigint, bigint];
  amountsOut: readonly [bigint, bigint];
  requestId: Uint8Array | null;
}

export function decodeSwapEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): SwapEvent | null {
  const decoded = GeneratedSwapEvent.decode(event);
  if (decoded === null) return null;
  return {
    sender: address(decoded.topics.sender, "sender"),
    recipient: address(decoded.topics.recipient, "recipient"),
    amountsIn: amounts(decoded.fields.amounts_in, "amounts_in"),
    amountsOut: amounts(decoded.fields.amounts_out, "amounts_out"),
    requestId:
      decoded.fields.request_id === null
        ? null
        : requestId(decoded.fields.request_id as Uint8Array | bigint[]),
  };
}

export function decodeRequestFailed(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): Uint8Array | null {
  const decoded = RequestFailed.decode(event);
  return decoded === null ? null : requestId(decoded.topics.request_id);
}

export function extractAcceptedRequestId(
  receipt: TransactionReceipt,
  driverAddress: ContractAddress,
): Uint8Array {
  const matches = receipt.events.flatMap((event) => {
    if (!bytesEqual(event.contractAddress, driverAddress)) return [];
    const decoded = RequestAccepted.decode(event);
    if (decoded === null) return [];
    if (event.data.length !== 0) {
      throw new Error("RequestAccepted payload must be empty");
    }
    return [requestId(decoded.topics.request_id)];
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected one RequestAccepted event, received ${matches.length}`,
    );
  }
  return matches[0]!;
}

function amounts(values: bigint[], name: string): readonly [bigint, bigint] {
  if (values.length !== 2 || values[0] === undefined || values[1] === undefined) {
    throw new Error(`SwapEvent ${name} must contain two amounts`);
  }
  return [values[0], values[1]];
}

function address(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== 32) {
    throw new Error(`SwapEvent ${name} must be 32 bytes`);
  }
  return value;
}

function requestId(value: Uint8Array | readonly bigint[]): Uint8Array {
  if (value.length !== 32) throw new Error("Request ID must be 32 bytes");
  if (value instanceof Uint8Array) return value.slice();
  if (value.some((byte) => byte < 0n || byte > 255n)) {
    throw new Error("Request ID contains an invalid byte");
  }
  return Uint8Array.from(value, Number);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length
    && left.every((byte, index) => byte === right[index])
  );
}
