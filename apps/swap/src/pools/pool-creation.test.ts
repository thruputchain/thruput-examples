import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import type { GlobalConfig } from "@/config";
import type { Erc20ReadAdapter } from "@/contracts/erc20-adapter";
import type { SwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import {
  integerSquareRoot,
  PoolCreationValidationError,
  preparePoolCreation,
} from "./pool-creation";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const view = <T>(value: T, height = 7n) => ({ value, height, events: [] });
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  poolContractFunding: 100n,
} satisfies GlobalConfig;
const pool = {
  pair: address(20),
  liquidityToken: address(21),
  handler: address(22),
  driver: address(23),
};

describe("pool creation review", () => {
  it("orients amounts canonically and derives exact requirements", async () => {
    const review = await preparePoolCreation(
      config,
      { tokenA: hex(2), tokenB: hex(1), amountA: "3", amountB: "2" },
      50n,
      dependencies(),
    );

    expect(review.token0).toMatchObject({
      addressHex: hex(1),
      symbol: "T1",
      amount: 2_000n,
      approvalDifference: 1_500n,
    });
    expect(review.token1).toMatchObject({
      addressHex: hex(2),
      symbol: "T2",
      amount: 3_000n,
      approvalDifference: 2_500n,
    });
    expect(review.initialLiquidity).toBe(2_449n);
    expect(review.totalFixedFunding).toBe(400n);
    expect(review.pool).toEqual(pool);
  });

  it("rejects existing pools, insufficient liquidity, and reserved HOG", async () => {
    await expect(preparePoolCreation(
      config,
      { tokenA: hex(1), tokenB: hex(2), amountA: "2", amountB: "2" },
      0n,
      dependencies({ existingPair: address(20) }),
    )).rejects.toMatchObject({ code: "poolExists" });

    await expect(preparePoolCreation(
      config,
      { tokenA: hex(1), tokenB: hex(2), amountA: "1", amountB: "1" },
      0n,
      dependencies(),
    )).rejects.toMatchObject({ code: "minimumLiquidity" });

    await expect(preparePoolCreation(
      config,
      { tokenA: hex(1), tokenB: hex(2), amountA: "2", amountB: "2" },
      700n,
      dependencies(),
    )).rejects.toMatchObject({ code: "hogBalance" });
  });

  it("combines native-HOG liquidity with fixed funding requirements", async () => {
    const deps = dependencies();
    const token = deps.token;
    deps.token = (tokenAddress) => {
      const adapter = token(tokenAddress);
      return tokenAddress[0] === 1
        ? { ...adapter, balanceOf: async () => view(1_000n) }
        : adapter;
    };

    await expect(preparePoolCreation(
      { ...config, nativeHogAddress: address(1) },
      { tokenA: hex(1), tokenB: hex(2), amountA: "0.7", amountB: "2" },
      0n,
      deps,
    )).rejects.toMatchObject({ code: "hogBalance" });
  });

  it("fails after bounded incoherent reads", async () => {
    const deps = dependencies();
    let height = 0n;
    deps.factory!.getPair = async () => view(null, ++height);

    await expect(preparePoolCreation(
      config,
      { tokenA: hex(1), tokenB: hex(2), amountA: "2", amountB: "2" },
      0n,
      deps,
    )).rejects.toEqual(expect.objectContaining<Partial<PoolCreationValidationError>>({
      code: "staleReads",
    }));
  });
});

describe("integerSquareRoot", () => {
  it.each([
    [0n, 0n],
    [1n, 1n],
    [2n, 1n],
    [15n, 3n],
    [16n, 4n],
    [17n, 4n],
    [10n ** 40n, 10n ** 20n],
  ])("floors sqrt(%s)", (value, expected) => {
    expect(integerSquareRoot(value)).toBe(expected);
  });
});

function dependencies(options: { existingPair?: ReturnType<typeof address> } = {}): {
  factory: SwapFactoryReadAdapter;
  token: (token: ReturnType<typeof address>) => Erc20ReadAdapter;
} {
  return {
    factory: {
      allPairsLength: async () => view(0n),
      pairAt: async () => view(null),
      getPair: async () => view(options.existingPair ?? null),
      poolAddresses: async () => view(pool),
      feeTo: async () => view(null),
    },
    token: (token) => ({
      balanceOf: async () => view(token[0] === 6 ? 1_000n : 10_000n),
      allowance: async () => view(500n),
      metadata: async () => ({
        name: view(`Token ${token[0]}`),
        symbol: view(`T${token[0]}`),
        decimals: view(token[0] === 6 ? null : 3),
      }),
    }),
  };
}
