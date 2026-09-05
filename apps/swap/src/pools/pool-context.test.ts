import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import type { SwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { createReadClient } from "@/groundhog/client";
import {
  PoolIdentityError,
  PoolNotFoundError,
  resolvePoolConfig,
} from "./pool-context";

vi.mock("@/contracts/erc20-adapter", () => ({
  createErc20ReadAdapter: vi.fn(),
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
  vi.mocked(createErc20ReadAdapter)
    .mockReturnValueOnce(tokenAdapter("A", 6))
    .mockReturnValueOnce(tokenAdapter("B", 8));
});

describe("resolvePoolConfig", () => {
  it("resolves a registered pool at one block height", async () => {
    const factory = factoryAdapter();

    await expect(resolvePoolConfig(config, address(5), address(6), factory))
      .resolves.toMatchObject({
        factoryAddress: address(3),
        liquidityTokenAddress: address(8),
        handlerAddress: address(9),
        driverAddress: address(10),
        tokenASymbol: "A",
        tokenBSymbol: "B",
        tokenADecimals: 6,
        tokenBDecimals: 8,
      });
  });

  it("distinguishes a missing pool from inconsistent factory data", async () => {
    const missing = factoryAdapter({ registered: null });
    await expect(resolvePoolConfig(config, address(5), address(6), missing))
      .rejects.toBeInstanceOf(PoolNotFoundError);

    vi.mocked(createErc20ReadAdapter)
      .mockReset()
      .mockReturnValueOnce(tokenAdapter("A", 6))
      .mockReturnValueOnce(tokenAdapter("B", 8));
    const inconsistent = factoryAdapter({ registered: address(11) });
    await expect(resolvePoolConfig(config, address(5), address(6), inconsistent))
      .rejects.toBeInstanceOf(PoolIdentityError);
  });

});

function tokenAdapter(symbol: string, decimals: number) {
  const view = (value: unknown) => ({ value, height: 5n, events: [] });
  return {
    metadata: vi.fn().mockResolvedValue({
      name: view(`Token ${symbol}`),
      symbol: view(symbol),
      decimals: view(decimals),
    }),
    balanceOf: vi.fn(),
    allowance: vi.fn(),
  };
}

function factoryAdapter(options: { registered?: ReturnType<typeof address> | null } = {}) {
  const view = <T,>(value: T) => ({ value, height: 5n, events: [] });
  return {
    allPairsLength: vi.fn(),
    pairAt: vi.fn(),
    feeTo: vi.fn(),
    getPair: vi.fn().mockResolvedValue(
      view(options.registered === undefined ? address(9) : options.registered),
    ),
    poolAddresses: vi.fn().mockResolvedValue(view({
      liquidityToken: address(8),
      handler: address(9),
      driver: address(10),
    })),
  } as unknown as SwapFactoryReadAdapter;
}
