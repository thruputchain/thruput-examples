import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import type { Erc20ReadAdapter } from "@/contracts/erc20-adapter";
import type { SwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import {
  integerSquareRoot,
  PoolCreationValidationError,
  preparePoolCreation,
} from "./pool-creation";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
} satisfies GlobalConfig;
const input = {
  tokenA: `0x${"05".repeat(32)}`,
  tokenB: `0x${"06".repeat(32)}`,
  amountA: "2",
  amountB: "8",
};

describe("preparePoolCreation", () => {
  it("retries a changed factory snapshot without treating it as a different pool", async () => {
    const deps = dependencies();
    const pool = { handler: address(7), driver: address(8), liquidityToken: address(9) };
    vi.mocked(deps.factory.getPair).mockResolvedValue(view(pool.handler));
    vi.mocked(deps.factory.poolAddresses).mockResolvedValueOnce({ ...view(pool), height: 11n }).mockResolvedValue(view(pool));
    const review = await preparePoolCreation(config, input, 0n, { ...deps, existingPool: pool });
    expect(review.pool).toEqual(pool);
    expect(deps.factory.getPair).toHaveBeenCalledTimes(2);
    vi.mocked(deps.factory.poolAddresses).mockResolvedValue({ ...view(pool), height: 11n });
    await expect(preparePoolCreation(config, input, 0n, { ...deps, existingPool: pool })).rejects.toMatchObject({ code: "staleReads" });
  });

  it("still rejects different pool addresses at the same height", async () => {
    const deps = dependencies();
    const pool = { handler: address(7), driver: address(8), liquidityToken: address(9) };
    vi.mocked(deps.factory.getPair).mockResolvedValue(view(pool.handler));
    vi.mocked(deps.factory.poolAddresses).mockResolvedValue(view({ ...pool, driver: address(10) }));
    await expect(preparePoolCreation(config, input, 0n, { ...deps, existingPool: pool })).rejects.toMatchObject({ code: "poolIdentity" });
    expect(deps.factory.getPair).toHaveBeenCalledOnce();
  });

  it("rejects the wrong network before any authoritative contract reads", async () => {
    const deps = dependencies();
    deps.client.getNetworkInfo.mockResolvedValue({ networkHash: new Uint8Array(32).fill(1) });
    await expect(preparePoolCreation(config, input, 0n, deps)).rejects.toMatchObject({ name: "NetworkMismatchError" });
    expect(deps.factory.getPair).not.toHaveBeenCalled();
    expect(deps.token).not.toHaveBeenCalled();
  });
  it("uses the factory recommendation and approves all three contracts", async () => {
    const review = await preparePoolCreation(config, input, 0n, dependencies());

    expect(review.pool).toBeNull();
    expect(review.fundingMinimum).toBe(100n);
    expect(review.fundingPerContract).toBe(1_000n);
    expect(review.totalFunding).toBe(3_000n);
    expect(review.fundingApprovalDifference).toBe(2_500n);
    expect(review.initialLiquidity).toBe(4_000_000n);
  });

  it("rejects an existing pool before predicting child addresses", async () => {
    const deps = dependencies();
    vi.mocked(deps.factory!.getPair).mockResolvedValue(view(address(7)));

    await expect(preparePoolCreation(config, input, 0n, deps)).rejects.toMatchObject({
      code: "poolExists",
    });
    expect(deps.factory!.poolAddresses).not.toHaveBeenCalled();
  });

  it("rejects a malformed funding policy", async () => {
    const deps = dependencies();
    vi.mocked(deps.factory!.poolFunding).mockResolvedValue(view({ min: 1_001n, recommended: 1_000n }));

    await expect(preparePoolCreation(config, input, 0n, deps)).rejects.toBeInstanceOf(
      PoolCreationValidationError,
    );
  });
});

describe("integerSquareRoot", () => {
  it.each([
    [0n, 0n],
    [1n, 1n],
    [15n, 3n],
    [16n, 4n],
  ])("returns floor sqrt for %s", (value, expected) => {
    expect(integerSquareRoot(value)).toBe(expected);
  });
});

function dependencies() {
  const client = { view: vi.fn(), getNetworkInfo: vi.fn().mockResolvedValue({ networkHash: new Uint8Array(32) }) };
  const factory: SwapFactoryReadAdapter = {
    allPairsLength: vi.fn(),
    pairAt: vi.fn(),
    getPair: vi.fn().mockResolvedValue(view(null)),
    poolAddresses: vi.fn(),
    poolFunding: vi.fn().mockResolvedValue(view({ min: 100n, recommended: 1_000n })),
    feeTo: vi.fn(),
  };
  const token = vi.fn((contract) => tokenAdapter(contract === config.nativeHogAddress));
  return { client, factory, token };
}

function tokenAdapter(native: boolean): Erc20ReadAdapter {
  return {
    metadata: vi.fn().mockResolvedValue({
      name: view(native ? "HOG" : "Token"),
      symbol: view(native ? "HOG" : "TKN"),
      decimals: view(6),
    }),
    balanceOf: vi.fn().mockResolvedValue(view(native ? 100_000n : 20_000_000n)),
    allowance: vi.fn().mockResolvedValue(view(native ? 500n : 0n)),
  };
}

function view<T>(value: T) {
  return { value, height: 10n, events: [] };
}
