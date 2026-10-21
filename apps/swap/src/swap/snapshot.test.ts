import { contractAddress } from "@thruputchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { createSwapHandlerReadAdapter } from "@/contracts/handler-adapter";

import { createSnapshotReader } from "./snapshot";

vi.mock("@/contracts/erc20-adapter", () => ({
  createErc20ReadAdapter: vi.fn(),
}));
vi.mock("@/contracts/handler-adapter", () => ({
  createSwapHandlerReadAdapter: vi.fn(),
}));
vi.mock("@/contracts/factory-adapter", () => ({
  createSwapFactoryReadAdapter: vi.fn(),
}));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: "09".padStart(64, "0"),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(8),
  nativeHogAddress: address(9),
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
    const client = { simulateInvocation: vi.fn() } as never;

    const tokenA = tokenAdapter("Token A", "A", 10n, 1n, 8n);
    const tokenB = tokenAdapter("Token B", "B", 20n, 2n, 8n);
    const liquidityToken = tokenAdapter(null, null, 30n, 0n, 8n, null);
    vi.mocked(createErc20ReadAdapter)
      .mockReturnValueOnce(tokenA)
      .mockReturnValueOnce(tokenB)
      .mockReturnValueOnce(liquidityToken);
    vi.mocked(createSwapHandlerReadAdapter).mockReturnValue({
      poolState: vi.fn().mockResolvedValue({
        value: {
          reserve0: 100n,
          reserve1: 200n,
          blockTimestamp: 5n,
          liquidity: 300n,
          liquidityToken: config.liquidityTokenAddress,
          cumulativePrices: [0n, 0n],
        },
        stateBlockHeight: 8n,
        events: [],
      }),
    });
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      feeTo: vi
        .fn()
        .mockResolvedValue({ value: null, stateBlockHeight: 8n, events: [] }),
      getPair: vi
        .fn()
        .mockResolvedValue({
          value: config.handlerAddress,
          stateBlockHeight: 8n,
          events: [],
        }),
      poolAddresses: vi.fn().mockResolvedValue({
        value: {
          liquidityToken: config.liquidityTokenAddress,
          handler: config.handlerAddress,
          driver: config.driverAddress,
        },
        stateBlockHeight: 8n,
        events: [],
      }),
    } as never);

    await expect(createSnapshotReader(config, client)()).resolves.toMatchObject(
      {
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
      },
    );
  });

  it("fails after three attempts when view heights do not match", async () => {
    vi.mocked(createErc20ReadAdapter)
      .mockReturnValueOnce(tokenAdapter("A", "A", 1n, 0n, 1n))
      .mockReturnValueOnce(tokenAdapter("B", "B", 1n, 0n, 1n))
      .mockReturnValueOnce(tokenAdapter("LP", "LP", 0n, 0n, 1n));
    vi.mocked(createSwapHandlerReadAdapter).mockReturnValue({
      poolState: vi.fn().mockResolvedValue({
        value: {
          reserve0: 1n,
          reserve1: 1n,
          blockTimestamp: 1n,
          liquidity: 1n,
          liquidityToken: config.liquidityTokenAddress,
          cumulativePrices: [0n, 0n],
        },
        stateBlockHeight: 2n,
        events: [],
      }),
    });
    vi.mocked(createSwapFactoryReadAdapter).mockReturnValue({
      feeTo: vi
        .fn()
        .mockResolvedValue({ value: null, stateBlockHeight: 2n, events: [] }),
      getPair: vi
        .fn()
        .mockResolvedValue({
          value: config.handlerAddress,
          stateBlockHeight: 2n,
          events: [],
        }),
      poolAddresses: vi.fn().mockResolvedValue({
        value: {
          liquidityToken: config.liquidityTokenAddress,
          handler: config.handlerAddress,
          driver: config.driverAddress,
        },
        stateBlockHeight: 2n,
        events: [],
      }),
    } as never);

    await expect(
      createSnapshotReader(config, { simulateInvocation: vi.fn() })(),
    ).rejects.toThrow("consistent chain snapshot after three attempts");
  });
});

function tokenAdapter(
  name: string | null,
  symbol: string | null,
  balance: bigint,
  allowance: bigint,
  height: bigint,
  decimals: number | null = 6,
) {
  return {
    metadata: vi.fn().mockResolvedValue({
      name: { value: name, stateBlockHeight: height, events: [] },
      symbol: { value: symbol, stateBlockHeight: height, events: [] },
      decimals: { value: decimals, stateBlockHeight: height, events: [] },
    }),
    balanceOf: vi
      .fn()
      .mockResolvedValue({
        value: balance,
        stateBlockHeight: height,
        events: [],
      }),
    allowance: vi
      .fn()
      .mockResolvedValue({
        value: allowance,
        stateBlockHeight: height,
        events: [],
      }),
  };
}
