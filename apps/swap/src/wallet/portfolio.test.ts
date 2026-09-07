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
  knownTokenAddresses: [address(14)],
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
      getPair: vi.fn(() => Promise.resolve(view(address(12)))),
      poolAddresses: vi.fn((_token0, token1) =>
        Promise.resolve(
          view({
            liquidityToken: address(token1[0] === 6 ? 7 : 9),
            handler: address(12),
            driver: address(13),
          }),
        ),
      ),
    } as never);
    const assets = new Map([
      [4, token("Native HOG", "HOG", 6, 15_000_000_000n)],
      [5, token("Token A", "A", 6, 1_000_000_000n)],
      [6, token("Token B", "B", 6, 0n)],
      [7, token(null, null, null, 30n)],
      [8, token("Token C", "C", 6, 1_000_000_000n)],
      [9, failingToken()],
      [14, token("Groundhog JPY", "JPY", 6, 2_000_000_000n)],
    ]);
    vi.mocked(createErc20ReadAdapter).mockImplementation(
      ({ contract }) => assets.get(contract[0]!) as never,
    );

    await expect(createWalletPortfolioReader(config)()).resolves.toMatchObject({
      tokens: [
        { symbol: "JPY", balance: 2_000_000_000n },
        { symbol: "HOG", decimals: 7, balance: 15_000_000_000n },
        { symbol: "A", balance: 1_000_000_000n },
        { symbol: "C", balance: 1_000_000_000n },
      ],
      liquidityPositions: [
        {
          symbol: "LP",
          decimals: 6,
          balance: 30n,
          poolSymbols: ["A", "B"],
        },
      ],
      invalidPoolCount: 1,
      unavailableAssetCount: 1,
    });
    expect(createErc20ReadAdapter).toHaveBeenCalledTimes(7);
    expect(
      vi
        .mocked(createErc20ReadAdapter)
        .mock.calls.filter(([params]) => params.contract[0] === 5),
    ).toHaveLength(1);
    expect(assets.get(4)!.metadata).not.toHaveBeenCalled();
    assets.set(5, token(null, null, 6, 1_000_000_000n));
    assets.set(6, token(null, null, 6, 0n));
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      allPairsLength: vi.fn().mockResolvedValue(view(1n)),
      pairAt: vi.fn().mockResolvedValue(view([address(5), address(6)] as const)),
      getPair: vi.fn().mockResolvedValue(view(address(12))),
      poolAddresses: vi.fn().mockResolvedValue(view({ liquidityToken: address(7), handler: address(12), driver: address(13) })),
    } as never);
    const fallback = await createWalletPortfolioReader(config)();
    expect(fallback.tokens.find((token) => token.address[0] === 5)?.symbol).toBe(`0x${"05".repeat(32)}`);
    expect(fallback.liquidityPositions[0]).toMatchObject({
      poolSymbols: [`0x${"05".repeat(32)}`, `0x${"06".repeat(32)}`],
      poolTokens: [address(5), address(6)],
    });
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
