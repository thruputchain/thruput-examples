import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it, vi } from "vitest";

import { createSwapPairReadAdapter } from "./pair-adapter";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

describe("createSwapPairReadAdapter", () => {
  it("decodes reserves", async () => {
    const view = vi.fn().mockResolvedValue({
      output: {
        result: "return",
        returnData: Uint8Array.from([0, 10, 0, 20, 30]),
      },
      events: [],
      height: 1n,
    });
    const contract = address(3);
    const caller = address(4);
    const adapter = createSwapPairReadAdapter({
      client: { view },
      contract,
      caller,
    });

    await expect(adapter.reserves()).resolves.toEqual({
      value: {
        reserve0: 10n,
        reserve1: 20n,
        blockTimestamp: 30n,
      },
      height: 1n,
    });
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({ contract, caller }),
    );
  });
});
