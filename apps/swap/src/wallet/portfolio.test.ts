import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { createReadClient } from "@/groundhog/client";
import { createWalletPortfolioReader } from "@/wallet/portfolio";

vi.mock("@/contracts/erc20-adapter", () => ({
  createErc20ReadAdapter: vi.fn(),
}));
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
  poolContractFunding: 10_000_000n,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createReadClient).mockReturnValue({} as never);
});

describe("createWalletPortfolioReader", () => {
  it("deduplicates known tokens and returns non-zero token and LP holdings", async () => {
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      allPairsLength: vi.fn().mockResolvedValue(view(3n)),
      pairAt: vi
        .fn()
        .mockResolvedValueOnce(view([address(5), address(6)] as const))
        .mockResolvedValueOnce(view([address(5), address(8)] as const))
        .mockResolvedValueOnce(view(null)),
      getPair: vi.fn((_token0, token1) =>
        Promise.resolve(view(address(token1[0] === 6 ? 10 : 11))),
      ),
      poolAddresses: vi.fn((_token0, token1) =>
        Promise.resolve(
          view({
            pair: address(token1[0] === 6 ? 10 : 11),
            liquidityToken: address(token1[0] === 6 ? 7 : 9),
            handler: address(12),
            driver: address(13),
          }),
        ),
      ),
    } as never);
    const assets = new Map([
      [4, token("Native HOG", "HOG", 6, 5_000_000n)],
      [5, token("Token A", "A", 6, 2_000_000n)],
      [6, token("Token B", "B", 6, 0n)],
      [7, token(null, null, null, 30n)],
      [8, token("Token C", "C", 6, 4_000_000n)],
      [9, failingToken()],
    ]);
    vi.mocked(createErc20ReadAdapter).mockImplementation(
      ({ contract }) => assets.get(contract[0]!) as never,
    );

    await expect(createWalletPortfolioReader(config)()).resolves.toMatchObject({
      tokens: [
        { symbol: "A", balance: 2_000_000n },
        { symbol: "C", balance: 4_000_000n },
        { symbol: "HOG", balance: 5_000_000n },
      ],
      liquidityPositions: [
        {
          symbol: "LP",
          decimals: 0,
          balance: 30n,
          poolSymbols: ["A", "B"],
        },
      ],
      invalidPoolCount: 1,
      unavailableAssetCount: 1,
    });
    expect(createErc20ReadAdapter).toHaveBeenCalledTimes(6);
    expect(
      vi
        .mocked(createErc20ReadAdapter)
        .mock.calls.filter(([params]) => params.contract[0] === 5),
    ).toHaveLength(1);
    expect(assets.get(4)!.metadata).not.toHaveBeenCalled();
  });

  it("rejects registries that exceed the local portfolio limit", async () => {
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      allPairsLength: vi.fn().mockResolvedValue(view(101n)),
    } as never);

    await expect(createWalletPortfolioReader(config)()).rejects.toThrow(
      "pool registry is too large",
    );
    expect(createErc20ReadAdapter).not.toHaveBeenCalled();
  });
});

function token(
  name: string | null,
  symbol: string | null,
  decimals: number | null,
  balance: bigint,
) {
  return {
    metadata: vi.fn().mockResolvedValue({
      name: view(name),
      symbol: view(symbol),
      decimals: view(decimals),
    }),
    balanceOf: vi.fn().mockResolvedValue(view(balance)),
    allowance: vi.fn(),
  };
}

function failingToken() {
  return {
    metadata: vi.fn().mockRejectedValue(new Error("invalid token contract")),
    balanceOf: vi.fn().mockRejectedValue(new Error("invalid token contract")),
    allowance: vi.fn(),
  };
}

function view<T>(value: T) {
  return { value, height: 8n, events: [] };
}
