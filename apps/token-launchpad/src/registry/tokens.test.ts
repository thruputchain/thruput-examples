import { describe, expect, it, vi } from "vitest";

import { configuration } from "@/test/fixtures";
import type { RegistryToken } from "@/registry/client";
import {
  enrichTokenBalances,
  registryTokenToCreatedToken,
} from "@/registry/tokens";

describe("registry token adaptation", () => {
  it("maps immutable metadata without losing bigint precision", () => {
    const mapped = registryTokenToCreatedToken(token());
    expect(mapped).toMatchObject({
      name: "Unnamed token",
      symbol: "TOKEN",
      decimals: null,
      initialSupply: 170141183460469231731687303715884105727n,
      block: 900719925474099300000n,
      balance: null,
      balanceLoading: true,
      readError: true,
    });
  });

  it("reads balances in batches of ten and isolates token failures", async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const readBalance = vi.fn(async (_client, _config, item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active -= 1;
      if (item.addressHex.endsWith("0b")) throw new Error("view failed");
      return BigInt(`0x${item.addressHex.slice(-2)}`);
    });
    const tokens = Array.from({ length: 12 }, (_, index) =>
      registryTokenToCreatedToken(
        token(`0x${(index + 1).toString(16).padStart(64, "0")}`),
      ),
    );
    const resultPromise = enrichTokenBalances(
      {} as never,
      configuration(),
      tokens,
      undefined,
      readBalance,
    );
    await vi.waitFor(() => expect(readBalance).toHaveBeenCalledTimes(10));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(readBalance).toHaveBeenCalledTimes(12));
    pending.splice(0).forEach((resolve) => resolve());
    const result = await resultPromise;
    expect(maximumActive).toBe(10);
    expect(result[10]).toMatchObject({ balance: null, readError: true });
    expect(result[11]?.balance).toBe(12n);
  });
});

function token(address = `0x${"04".repeat(32)}`): RegistryToken {
  const config = configuration();
  return {
    networkId: config.networkIdHex,
    factoryAddress: `0x${"03".repeat(32)}`,
    tokenAddress: address,
    creatorAddress: `0x${"02".repeat(32)}`,
    administratorAddress: `0x${"05".repeat(32)}`,
    initialHolderAddress: `0x${"06".repeat(32)}`,
    initialSupply: "170141183460469231731687303715884105727",
    name: null,
    symbol: null,
    decimals: 19,
    tokenCodeHash: `0x${"00".repeat(32)}`,
    transactionHash: `0x${"07".repeat(32)}`,
    eventSequence: 0,
    blockHeight: "900719925474099300000",
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}
