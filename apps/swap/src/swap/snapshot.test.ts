import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { createSwapPairReadAdapter } from "@/contracts/pair-adapter";
import { createReadClient } from "@/groundhog/client";

import { createSnapshotReader } from "./snapshot";

vi.mock("@/contracts/erc20-adapter", () => ({
  createErc20ReadAdapter: vi.fn(),
}));
vi.mock("@/contracts/pair-adapter", () => ({
  createSwapPairReadAdapter: vi.fn(),
}));
vi.mock("@/contracts/factory-adapter", () => ({
  createSwapFactoryReadAdapter: vi.fn(),
}));
vi.mock("@/groundhog/client", () => ({
  createReadClient: vi.fn(),
}));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "09".padStart(64, "0"),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(8),
  nativeHogAddress: address(9),
  poolContractFunding: 10_000_000n,
  pairAddress: address(3),
  liquidityTokenAddress: address(10),
  handlerAddress: address(4),
  driverAddress: address(5),
  tokenAAddress: address(6),
  tokenBAddress: address(7),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSnapshotReader", () => {
  it("accepts views that all come from the same height", async () => {
    vi.mocked(createReadClient).mockReturnValue({} as never);

    const tokenA = tokenAdapter("Token A", "A", 10n, 1n, 8n);
    const tokenB = tokenAdapter("Token B", "B", 20n, 2n, 8n);
    const liquidityToken = tokenAdapter("LP", "LP", 30n, 0n, 8n);
    vi.mocked(createErc20ReadAdapter)
      .mockReturnValueOnce(tokenA)
      .mockReturnValueOnce(tokenB)
      .mockReturnValueOnce(liquidityToken);
    vi.mocked(createSwapPairReadAdapter).mockReturnValue({
      reserves: vi.fn().mockResolvedValue({
        value: { reserve0: 100n, reserve1: 200n, blockTimestamp: 5n },
        height: 8n,
        events: [],
      }),
      liquidity: vi.fn().mockResolvedValue({
        value: 300n,
        height: 8n,
        events: [],
      }),
    });
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      feeTo: vi.fn().mockResolvedValue({ value: null, height: 8n, events: [] }),
    } as never);

    await expect(createSnapshotReader(config)()).resolves.toMatchObject({
      tokenA: { name: "Token A", balance: 10n, allowance: 1n },
      tokenB: { name: "Token B", balance: 20n, allowance: 2n },
      reserve0: 100n,
      reserve1: 200n,
      liquidityTotalSupply: 300n,
      liquidityBalance: 30n,
      liquidityTokenSymbol: "LP",
      liquidityTokenDecimals: 6,
      feeTo: null,
      chainHeight: 8n,
    });
  });

  it("fails after three attempts when view heights do not match", async () => {
    vi.mocked(createReadClient).mockReturnValue({} as never);
    vi.mocked(createErc20ReadAdapter)
      .mockReturnValueOnce(tokenAdapter("A", "A", 1n, 0n, 1n))
      .mockReturnValueOnce(tokenAdapter("B", "B", 1n, 0n, 1n))
      .mockReturnValueOnce(tokenAdapter("LP", "LP", 0n, 0n, 1n));
    vi.mocked(createSwapPairReadAdapter).mockReturnValue({
      reserves: vi.fn().mockResolvedValue({
        value: { reserve0: 1n, reserve1: 1n, blockTimestamp: 1n },
        height: 2n,
        events: [],
      }),
      liquidity: vi.fn().mockResolvedValue({ value: 1n, height: 2n, events: [] }),
    });
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      feeTo: vi.fn().mockResolvedValue({ value: null, height: 2n, events: [] }),
    } as never);

    await expect(createSnapshotReader(config)()).rejects.toThrow(
      "consistent chain snapshot after three attempts",
    );
  });
});

function tokenAdapter(
  name: string,
  symbol: string,
  balance: bigint,
  allowance: bigint,
  height: bigint,
) {
  return {
    metadata: vi.fn().mockResolvedValue({
      name: { value: name, height, events: [] },
      symbol: { value: symbol, height, events: [] },
      decimals: { value: 6, height, events: [] },
    }),
    balanceOf: vi
      .fn()
      .mockResolvedValue({ value: balance, height, events: [] }),
    allowance: vi
      .fn()
      .mockResolvedValue({ value: allowance, height, events: [] }),
  };
}
