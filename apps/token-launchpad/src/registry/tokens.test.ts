import { toBase58 } from "@thruputchain/client";
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

function token(
  address = toBase58(new Uint8Array(32).fill(0x04)),
): RegistryToken {
  const config = configuration();
  return {
    networkId: config.networkId,
    factoryAddress: toBase58(new Uint8Array(32).fill(0x03)),
    tokenAddress: address,
    creatorAddress: toBase58(new Uint8Array(32).fill(0x02)),
    administratorAddress: toBase58(new Uint8Array(32).fill(0x05)),
    initialHolderAddress: toBase58(new Uint8Array(32).fill(0x06)),
    initialSupply: "170141183460469231731687303715884105727",
    name: null,
    symbol: null,
    decimals: 19,
    tokenCodeHash: toBase58(new Uint8Array(32).fill(0x00)),
    transactionHash: toBase58(new Uint8Array(32).fill(0x07)),
    eventSequence: 0,
    blockHeight: "900719925474099300000",
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}
