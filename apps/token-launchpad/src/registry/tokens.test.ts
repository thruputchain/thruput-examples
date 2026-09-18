import { describe, expect, it } from "vitest";

import { configuration } from "@/test/fixtures";
import type { RegistryToken } from "@/registry/client";
import { registryTokenToCreatedToken } from "@/registry/tokens";

describe("registry token adaptation", () => {
  it("maps immutable metadata without losing bigint precision", () => {
    const mapped = registryTokenToCreatedToken(token());
    expect(mapped).toMatchObject({
      name: "Unnamed token",
      symbol: "TOKEN",
      decimals: null,
      initialSupply: 170141183460469231731687303715884105727n,
      block: 900719925474099300000n,
    });
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
