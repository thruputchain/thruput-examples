import { toBase58 } from "@thruputchain/client";
import { describe, expect, it, vi } from "vitest";

import { configuration } from "@/test/fixtures";
import {
  getRegistryStatus,
  getRegistryTokens,
  RegistryClientError,
  requestRegistrySync,
} from "@/registry/client";

const tokenAddress = toBase58(new Uint8Array(32).fill(0x04));

describe("registry client", () => {
  it("builds a same-origin list request and validates its scope", async () => {
    const config = configuration();
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        tokens: [token(config)],
        total: 1,
        limit: 20,
        offset: 0,
        asOfBlock: "12",
        hasMore: false,
        historyLimited: false,
      }),
    );
    const page = await getRegistryTokens(
      config,
      {
        q: " Acorn ",
        creator: toBase58(config.accountAddress),
        sort: "name",
        limit: 20,
        offset: 0,
      },
      controller.signal,
      fetcher,
    );
    expect(page.tokens[0]?.initialSupply).toBe(
      "170141183460469231731687303715884105727",
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/api/tokens?sort=name&limit=20&offset=0&q=Acorn&creator=${encodeURIComponent(toBase58(config.accountAddress))}`,
      { method: "GET", signal: controller.signal },
    );
  });

  it("posts an empty same-origin sync request and propagates the signal", async () => {
    const config = configuration();
    const signal = new AbortController().signal;
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(status(config)));
    await requestRegistrySync(config, signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/registry/sync", {
      method: "POST",
      signal,
    });
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("rejects malformed, oversized, and cross-scope responses", async () => {
    const config = configuration();
    await expect(
      getRegistryStatus(
        config,
        undefined,
        vi.fn().mockResolvedValue(
          jsonResponse({
            ...status(config),
            networkId: toBase58(new Uint8Array(32).fill(0xff)),
          }),
        ),
      ),
    ).rejects.toThrow(/different chain scope/);
    await expect(
      getRegistryTokens(
        config,
        { sort: "newest", limit: 20, offset: 0 },
        undefined,
        vi.fn().mockResolvedValue(
          jsonResponse({
            tokens: [{ ...token(config), initialSupply: "01" }],
            total: 1,
            limit: 20,
            offset: 0,
            asOfBlock: "12",
            hasMore: false,
            historyLimited: false,
          }),
        ),
      ),
    ).rejects.toThrow(RegistryClientError);
    await expect(
      getRegistryStatus(
        config,
        undefined,
        vi.fn().mockResolvedValue(
          new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": "256001",
            },
          }),
        ),
      ),
    ).rejects.toThrow(/too large/);
  });

  it("rejects inconsistent status fields", async () => {
    const config = configuration();
    await expect(
      getRegistryStatus(
        config,
        undefined,
        vi.fn().mockResolvedValue(
          jsonResponse({
            ...status(config),
            syncState: "idle",
            syncing: true,
          }),
        ),
      ),
    ).rejects.toThrow(/syncing/);
  });

  it("accepts an empty page whose offset is beyond the total", async () => {
    const config = configuration();
    await expect(
      getRegistryTokens(
        config,
        { sort: "newest", limit: 20, offset: 20, asOfBlock: "12" },
        undefined,
        vi.fn().mockResolvedValue(
          jsonResponse({
            tokens: [],
            total: 0,
            limit: 20,
            offset: 20,
            asOfBlock: "12",
            hasMore: false,
            historyLimited: false,
          }),
        ),
      ),
    ).resolves.toMatchObject({ total: 0, offset: 20 });
  });

  it("rejects creator-filter violations and duplicate token addresses", async () => {
    const config = configuration();
    const creator = toBase58(config.accountAddress);
    const page = {
      tokens: [token(config)],
      total: 1,
      limit: 20,
      offset: 0,
      asOfBlock: "12",
      hasMore: false,
      historyLimited: false,
    };
    await expect(
      getRegistryTokens(
        config,
        { creator, sort: "newest", limit: 20, offset: 0 },
        undefined,
        vi.fn().mockResolvedValue(
          jsonResponse({
            ...page,
            tokens: [
              {
                ...token(config),
                creatorAddress: toBase58(new Uint8Array(32).fill(0x09)),
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(/creator filter/);
    await expect(
      getRegistryTokens(
        config,
        { sort: "newest", limit: 20, offset: 0 },
        undefined,
        vi.fn().mockResolvedValue(
          jsonResponse({
            ...page,
            tokens: [token(config), token(config)],
            total: 2,
          }),
        ),
      ),
    ).rejects.toThrow(/duplicate token address/);
  });
});

function token(config = configuration()) {
  return {
    networkId: config.networkId,
    factoryAddress: toBase58(config.factoryAddress),
    tokenAddress,
    creatorAddress: toBase58(config.accountAddress),
    administratorAddress: toBase58(new Uint8Array(32).fill(0x05)),
    initialHolderAddress: toBase58(new Uint8Array(32).fill(0x06)),
    initialSupply: "170141183460469231731687303715884105727",
    name: "Acorn",
    symbol: "NUT",
    decimals: 18,
    tokenCodeHash: toBase58(config.expectedTokenHash),
    transactionHash: toBase58(new Uint8Array(32).fill(0x07)),
    eventSequence: 0,
    blockHeight: "12",
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}

function status(config = configuration()) {
  return {
    networkId: config.networkId,
    factoryAddress: toBase58(config.factoryAddress),
    indexedThroughBlock: "12",
    tokenCount: 1,
    historyLimited: false,
    syncState: "idle",
    syncing: false,
    lastSuccessfulSyncAt: "2026-09-05T00:00:00.000Z",
    lastError: null,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
