import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { createReadClient } from "@/groundhog/client";
import { readPoolDirectory } from "./pool-directory";

vi.mock("@/contracts/factory-adapter", () => ({
  createSwapFactoryReadAdapter: vi.fn(),
}));
vi.mock("@/groundhog/client", () => ({ createReadClient: vi.fn() }));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const config: GlobalConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createReadClient).mockReturnValue({
    getChainTip: vi.fn().mockResolvedValue({ height: 5n }),
    getBlockByNumber: vi.fn().mockResolvedValue({ networkId: 0n }),
  } as never);
});

describe("readPoolDirectory", () => {
  it("loads valid pools while retaining an invalid-entry count", async () => {
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      allPairsLength: vi.fn().mockResolvedValue({ value: 3n }),
      pairAt: vi.fn()
        .mockResolvedValueOnce({ value: [address(5), address(6)] })
        .mockResolvedValueOnce({ value: null })
        .mockResolvedValueOnce({ value: [address(5), address(7)] }),
    } as never);
    const first = { config: { handlerAddress: address(8) }, snapshot: {} } as never;
    const loadPool = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("bad pool"));

    await expect(readPoolDirectory(config, { loadPool })).resolves.toEqual({
      entries: [first],
      invalidEntryCount: 2,
    });
    expect(loadPool).toHaveBeenCalledTimes(2);
  });

  it("handles an empty registry", async () => {
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      allPairsLength: vi.fn().mockResolvedValue({ value: 0n }),
      pairAt: vi.fn(),
    } as never);

    await expect(readPoolDirectory(config)).resolves.toEqual({
      entries: [],
      invalidEntryCount: 0,
    });
  });
});
