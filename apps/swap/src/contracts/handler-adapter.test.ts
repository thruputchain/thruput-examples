import { contractAddress } from "@thruputchain/protocol";
import { CxsWriter, Uint256Codec } from "@thruputchain/xdr";
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
    const cumulativePrices = [1n << 255n, (1n << 256n) - 1n] as const;
    Uint256Codec.encode(writer, cumulativePrices[0]);
    Uint256Codec.encode(writer, cumulativePrices[1]);
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
        cumulativePrices,
      },
      height: 1n,
      events: [],
    });
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({ contract, caller }),
    );
  });

});
