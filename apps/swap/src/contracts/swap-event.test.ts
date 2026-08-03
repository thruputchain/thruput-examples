import { CxsWriter, FixedArrayCodec, Uint128Codec } from "@groundhogchain/xdr";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { decodeSwapEvent, SWAP_EVENT_SIGNATURE } from "./swap-event.js";

const AmountsCodec = FixedArrayCodec(Uint128Codec, 2);

describe("decodeSwapEvent", () => {
  it("matches the SDK event-signature derivation", () => {
    expect(SWAP_EVENT_SIGNATURE).toEqual(
      sha256(new TextEncoder().encode("0.1::swap-pair::SwapEvent")),
    );
  });

  it("decodes the pinned event layout", () => {
    const writer = new CxsWriter();
    AmountsCodec.encode(writer, [7n, 0n]);
    AmountsCodec.encode(writer, [0n, 5n]);

    const event = decodeSwapEvent({
      topics: [SWAP_EVENT_SIGNATURE, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
      data: writer.finish(),
    });

    expect(event).toEqual({
      sender: new Uint8Array(32).fill(1),
      recipient: new Uint8Array(32).fill(2),
      amountsIn: [7n, 0n],
      amountsOut: [0n, 5n],
    });
  });

  it("ignores another event signature", () => {
    expect(
      decodeSwapEvent({ topics: [new Uint8Array(32)], data: new Uint8Array() }),
    ).toBeNull();
  });

  it("rejects invalid framing", () => {
    expect(() =>
      decodeSwapEvent({ topics: [SWAP_EVENT_SIGNATURE], data: new Uint8Array(64) }),
    ).toThrow("expected 3 topics");
  });
});
