import { fromHex0x } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { CxsWriter, Uint128Codec } from "@thruputchain/xdr";
import { describe, expect, it } from "vitest";
import { LiquidityMintEvent, LiquidityBurnEvent } from "./liquidity-events";

describe("liquidity event compatibility", () => {
  it.each([
    [
      LiquidityMintEvent,
      "0x48e990a9515a2084882012e9e7c7cf93100fd7f03be5f1665969aefe519444be",
      "0x972c26dc446a644066cd50d95bc7523ce1dd815f505dfc28cba88e00bcc771a7",
      false,
    ],
    [
      LiquidityBurnEvent,
      "0x44934a1f6a6a0d7c09f5464a14adefd9da1e9cde4d9420b333fecb917c47f52c",
      "0x3c2f1654cb81e61936b5544fd2ddec7c1ae881b4f6eca293cd21d0f3e5b999a3",
      true,
    ],
  ] as const)(
    "decodes both event generations and queries both signatures",
    (descriptor, original, renamed, burn) => {
      const writer = new CxsWriter();
      Uint128Codec.encode(writer, 10n);
      if (burn) Uint128Codec.encode(writer, 20n);
      writer.writeUint32(1n);
      const requestId = new Uint8Array(32).fill(4);
      writer.writeFixedOpaque(requestId, 32);
      const owner = contractAddress(new Uint8Array(32).fill(2));
      const data = writer.finish();
      for (const signature of [fromHex0x(original), fromHex0x(renamed)]) {
        const event = { topics: [signature, owner, owner], data };
        expect(descriptor.decode(event)?.fields.request_id).toEqual(requestId);
        expect(event.topics[0]).toBe(signature);
        expect(() =>
          descriptor.decode({ ...event, data: new Uint8Array() }),
        ).toThrow();
      }
      expect(
        descriptor.decode({ topics: [new Uint8Array(32), owner, owner], data }),
      ).toBeNull();
      expect(
        descriptor.filter({ contractAddresses: [owner] }).topics?.topic0,
      ).toEqual([fromHex0x(original), fromHex0x(renamed)]);
    },
  );
});
