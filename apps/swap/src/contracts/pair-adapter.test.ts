import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it, vi } from "vitest";

import { createSwapPairReadAdapter } from "./pair-adapter";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

describe("createSwapPairReadAdapter", () => {
  it("decodes reserves and orients them for either token direction", async () => {
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
      reserve0: 10n,
      reserve1: 20n,
      blockTimestamp: 30n,
    });
    await expect(adapter.reservesFor(address(2), address(1))).resolves.toEqual({
      reserveIn: 20n,
      reserveOut: 10n,
    });
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({ contract, caller }),
    );
  });
});
