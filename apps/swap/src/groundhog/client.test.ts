import type { GroundhogClient } from "@groundhogchain/client";
import { dbHash, sha256Hash } from "@groundhogchain/protocol";
import { describe, expect, it, vi } from "vitest";

import { getValidatedChainTip, resolveReadRpcUrl } from "./client";

const hash = (byte: number) => sha256Hash(new Uint8Array(32).fill(byte));

describe("resolveReadRpcUrl", () => {
  it("uses the same-origin local proxy for separate loopback ports", () => {
    expect(
      resolveReadRpcUrl(
        new URL("http://127.0.0.1:9545"),
        "http://127.0.0.1:5173",
      ),
    ).toBe("http://127.0.0.1:5173/groundhog-rpc");
  });

  it("does not rewrite same-origin or non-loopback endpoints", () => {
    expect(
      resolveReadRpcUrl(
        new URL("http://127.0.0.1:9545"),
        "http://127.0.0.1:9545",
      ),
    ).toBe("http://127.0.0.1:9545/");
    expect(
      resolveReadRpcUrl(
        new URL("https://rpc.example.com"),
        "https://swap.example.com",
      ),
    ).toBe("https://rpc.example.com/");
  });
});

describe("getValidatedChainTip", () => {
  it("returns a tip whose block matches the configured network", async () => {
    const client = networkClient(blockInfo(7n, 3n));

    await expect(getValidatedChainTip(client, 7n)).resolves.toEqual({
      height: 3n,
      blockHash: hash(1),
    });
  });

  it("fails closed for missing, wrong-height, or wrong-network blocks", async () => {
    await expect(getValidatedChainTip(networkClient(null), 7n)).rejects.toThrow(
      "did not return",
    );
    await expect(
      getValidatedChainTip(networkClient(blockInfo(7n, 2n)), 7n),
    ).rejects.toThrow("returned block height");
    await expect(
      getValidatedChainTip(networkClient(blockInfo(8n, 3n)), 7n),
    ).rejects.toThrow("does not match");
  });
});

function networkClient(
  block: Awaited<ReturnType<GroundhogClient["getBlockByNumber"]>>,
): Pick<GroundhogClient, "getChainTip" | "getBlockByNumber"> {
  return {
    getChainTip: vi.fn().mockResolvedValue({ height: 3n, blockHash: hash(1) }),
    getBlockByNumber: vi.fn().mockResolvedValue(block),
  };
}

function blockInfo(networkId: bigint, blockHeight: bigint) {
  return {
    networkId,
    blockHeight,
    txsetHash: hash(2),
    dbHash: dbHash(new Uint8Array(2_048).fill(3)),
    eventsHash: hash(4),
    prevBlockHash: hash(5),
  };
}
