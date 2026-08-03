import { CxsReader, FixedArrayCodec, Uint128Codec } from "@groundhogchain/xdr";
import { fromHex } from "@groundhogchain/protocol";

const AmountsCodec = FixedArrayCodec(Uint128Codec, 2);

// SDK 0.17.4 derives this from "0.1::swap-pair::SwapEvent".
export const SWAP_EVENT_SIGNATURE = fromHex(
  "53a6ad106368cc82d1e10500af6aea8ffa3b8ccb37582d4c38d92a7b80d01d0a",
);

export interface SwapEvent {
  sender: Uint8Array;
  recipient: Uint8Array;
  amountsIn: readonly [bigint, bigint];
  amountsOut: readonly [bigint, bigint];
}

export function decodeSwapEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): SwapEvent | null {
  if (!bytesEqual(event.topics[0] ?? new Uint8Array(), SWAP_EVENT_SIGNATURE)) {
    return null;
  }
  if (event.topics.length !== 3) {
    throw new Error(`SwapEvent: expected 3 topics, got ${event.topics.length}`);
  }

  const sender = addressTopic(event.topics[1], "sender");
  const recipient = addressTopic(event.topics[2], "recipient");
  const reader = new CxsReader(event.data);
  const amountsIn = tuple(AmountsCodec.decode(reader));
  const amountsOut = tuple(AmountsCodec.decode(reader));
  if (reader.remaining !== 0) {
    throw new Error(`SwapEvent: ${reader.remaining} trailing payload bytes`);
  }

  return { sender, recipient, amountsIn, amountsOut };
}

function addressTopic(value: Uint8Array | undefined, name: string): Uint8Array {
  if (value?.length !== 32) {
    throw new Error(`SwapEvent: ${name} topic must be 32 bytes`);
  }
  return value;
}

function tuple(values: bigint[]): readonly [bigint, bigint] {
  const [first, second] = values;
  if (first === undefined || second === undefined || values.length !== 2) {
    throw new Error("SwapEvent: expected two amounts");
  }
  return [first, second];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((byte, index) => byte === b[index]);
}
