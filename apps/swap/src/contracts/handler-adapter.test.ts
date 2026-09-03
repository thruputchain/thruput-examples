import { contractAddress } from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { describe, expect, it, vi } from "vitest";

import { createSwapHandlerReadAdapter } from "./handler-adapter";

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));

describe("createSwapHandlerReadAdapter", () => {
  it("reads coherent pool state", async () => {
    const writer = new CxsWriter();
    writer.writeUint128(10n);
    writer.writeUint128(20n);
    writer.writeUint32(30n);
    writer.writeUint128(42n);
    writer.writeFixedOpaque(address(5), 32);
    const cumulativePrices = new Uint8Array(64);
    const cumulativePriceView = new DataView(cumulativePrices.buffer);
    for (let index = 0; index < 16; index += 1) {
      cumulativePriceView.setUint32(index * 4, index + 1, false);
    }
    writer.writeFixedOpaque(cumulativePrices, 64);
    const view = vi.fn().mockResolvedValue({
      output: {
        result: "return",
        returnData: writer.finish(),
      },
      events: [],
      height: 1n,
    });
    const contract = address(3);
    const caller = address(4);
    const adapter = createSwapHandlerReadAdapter({
      client: { view },
      contract,
      caller,
    });

    await expect(adapter.poolState()).resolves.toEqual({
      value: {
        reserve0: 10n,
        reserve1: 20n,
        blockTimestamp: 30n,
        liquidity: 42n,
        liquidityToken: address(5),
        cumulativePrices: [
          { limbs: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] },
          { limbs: [9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n] },
        ],
      },
      height: 1n,
      events: [],
    });
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({ contract, caller }),
    );
  });

});
