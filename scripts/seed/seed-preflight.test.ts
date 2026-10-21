// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contractAddress } from "@thruputchain/protocol";
import type { StorageItemRead } from "@thruputchain/client";
import {
  seedStorageKey,
  seedTransport,
  verifySwapRelationship,
} from "./seed-preflight.ts";

describe("seed RPC redirects", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0))
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const listen = async (server: Server) => {
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    return `http://127.0.0.1:${address.port}`;
  };

  it("never follows a local 307 or forwards the transaction body", async () => {
    const target = vi.fn();
    const destination = await listen(
      createServer((request, response) => {
        target();
        request.resume();
        response.end("{}");
      }),
    );
    const source = await listen(
      createServer((request, response) => {
        request.resume();
        response.writeHead(307, { location: destination });
        response.end();
      }),
    );
    await expect(
      seedTransport(source).request("sendTransaction", ["test-payload"]),
    ).rejects.toThrow();
    expect(target).not.toHaveBeenCalled();
  });
});

describe("live swap relationship preflight", () => {
  const factory = contractAddress(new Uint8Array(32).fill(1));
  const router = contractAddress(new Uint8Array(32).fill(2));
  const other = contractAddress(new Uint8Array(32).fill(3));
  const storage = (bytes: Uint8Array): StorageItemRead => ({
    stateBlockHeight: 1n,
    item: { kind: "bytestring", bytes },
  });

  it("checks both pinned immutable slots, rather than trusting poolFunding or the env pair", async () => {
    const getStorage = vi
      .fn()
      .mockResolvedValueOnce(storage(router))
      .mockResolvedValueOnce(storage(factory));
    await verifySwapRelationship({ getStorage }, factory, router);
    expect(getStorage.mock.calls).toEqual([
      [{ address: factory, key: seedStorageKey("Factory", 2) }],
      [{ address: router, key: seedStorageKey("Router", 0) }],
    ]);
  });

  it.each(["factory", "router"])(
    "rejects a %s configured for another counterpart",
    async (side) => {
      const getStorage = vi
        .fn()
        .mockResolvedValueOnce(storage(side === "factory" ? other : router))
        .mockResolvedValueOnce(storage(other));
      await expect(
        verifySwapRelationship({ getStorage }, factory, router),
      ).rejects.toThrow("relationship mismatch");
    },
  );

  it.each([
    null,
    { kind: "bytestring", bytes: new Uint8Array(31) },
    { kind: "nonnegativeInt", value: 2n },
  ])("rejects missing or unsupported storage", async (item) => {
    const getStorage = vi.fn().mockResolvedValue({ stateBlockHeight: 1n, item });
    await expect(
      verifySwapRelationship({ getStorage }, factory, router),
    ).rejects.toThrow("unsupported storage layout");
  });
});
