// @vitest-environment node

import {
  addressFromHex,
  fixedBytes,
  GroundhogRpcErrorCode,
  hashFromHex,
  JsonRpcError,
} from "@groundhogchain/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GroundhogRegistrySource,
  RegistryCursorRejectedError,
  RegistryIntegrityError,
  RegistryScopeVerificationError,
} from "./chain.ts";
import type { RegistryScope } from "./domain.ts";
import { RegistryIndexer } from "./indexer.ts";
import { RegistryStore } from "./store.ts";
import {
  StandardTokenFactory,
  TokenCreated,
} from "../src/contracts/generated/standard-token-factory.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: `0x${"22".repeat(32)}`,
  tokenCodeHash: `0x${"33".repeat(32)}`,
};
const client = { view: vi.fn(), getEvents: vi.fn(), getNetworkInfo: vi.fn() };

beforeEach(() => {
  client.getEvents.mockReset();
  client.getNetworkInfo.mockReset().mockResolvedValue({
    networkHash: hashFromHex(`0x${scope.networkId}`),
  });
});

afterEach(() => vi.restoreAllMocks());

describe("GroundhogRegistrySource", () => {
  it.each(["before scan", "during page", "empty page", "no new blocks"])(
    "halts without committing when the network changes: %s",
    async (timing) => {
      vi.spyOn(StandardTokenFactory.config, "view").mockResolvedValue({
        value: factoryConfig(0x33),
        height: 1n,
        events: [],
      });
      vi.spyOn(TokenCreated, "decode").mockReturnValue({
        name: "TokenCreated",
        topics: { token: address(0x44), creator: address(0x55) },
        fields: {
          administrator: address(0x66),
          initial_holder: address(0x77),
          initial_supply: 123n,
          name: "Token",
          symbol: "TOK",
          decimals: 7n,
          token_code_hash: factoryConfig(0x33).token_code_hash,
        },
      });
      const source = new GroundhogRegistrySource(client, scope);
      await source.verifyNetworkIdentity(new AbortController().signal);
      await source.verifyScope();
      const switchNetwork = () =>
        client.getNetworkInfo.mockResolvedValue({
          networkHash: hashFromHex(`0x${"99".repeat(32)}`),
        });
      client.getEvents.mockImplementation(async () => {
        switchNetwork();
        return {
          events:
            timing === "empty page" || timing === "no new blocks"
              ? []
              : [identifiedEvent()],
          cursor: new Uint8Array(),
          latestBlock: timing === "no new blocks" ? 0n : 8n,
          oldestBlock: 1n,
        };
      });
      if (timing === "before scan") switchNetwork();
      const store = new RegistryStore(":memory:", scope);
      const commit = vi.spyOn(store, "commitPage");
      const indexer = new RegistryIndexer(store, source, {
        pageSize: 20,
        syncIntervalMs: 60_000,
      });
      try {
        await indexer.sync();
        await indexer.sync();
        expect(commit).not.toHaveBeenCalled();
        expect(store.getScan()).toBeNull();
        expect(store.getStatus()).toMatchObject({
          syncState: "integrityFault",
          indexedThroughBlock: "0",
          tokenCount: 0,
          lastSuccessfulSyncAt: null,
          lastError:
            "The RPC endpoint belongs to a different Groundhog network",
        });
        expect(client.getEvents).toHaveBeenCalledTimes(
          timing === "before scan" ? 0 : 1,
        );
      } finally {
        await indexer.stop();
        store.close();
      }
    },
  );

  it.each(["before scan", "after retrieval"])(
    "retries sanitized network RPC failures %s",
    async (timing) => {
      const secret = "https://rpc.example.test/?token=private-secret";
      const failure = new Error(secret);
      client.getEvents.mockImplementation(async () => {
        if (timing === "after retrieval")
          client.getNetworkInfo.mockRejectedValueOnce(failure);
        return {
          events: [],
          cursor: new Uint8Array(),
          latestBlock: 8n,
          oldestBlock: 1n,
        };
      });
      if (timing === "before scan")
        client.getNetworkInfo.mockRejectedValueOnce(failure);
      const store = new RegistryStore(":memory:", scope);
      const sleep = vi.fn(async () => {
        expect(store.getStatus()).toMatchObject({
          syncState: "retrying",
          indexedThroughBlock: "0",
          tokenCount: 0,
          lastError: "Registry synchronization is temporarily unavailable",
        });
        expect(store.getScan()).toBeNull();
        client.getEvents.mockResolvedValue({
          events: [],
          cursor: new Uint8Array(),
          latestBlock: 8n,
          oldestBlock: 1n,
        });
      });
      const indexer = new RegistryIndexer(
        store,
        new GroundhogRegistrySource(client, scope),
        {
          pageSize: 20,
          syncIntervalMs: 60_000,
          sleep,
        },
      );
      try {
        await indexer.sync();
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(store.getStatus()).toMatchObject({
          syncState: "idle",
          indexedThroughBlock: "8",
          lastError: null,
        });
        expect(JSON.stringify(store.getStatus())).not.toContain(secret);
      } finally {
        await indexer.stop();
        store.close();
      }
    },
  );

  it("verifies the configured factory token implementation", async () => {
    vi.spyOn(StandardTokenFactory.config, "view").mockResolvedValue({
      value: factoryConfig(0x33),
      height: 1n,
      events: [],
    });

    await expect(
      new GroundhogRegistrySource(client, scope).verifyScope(),
    ).resolves.toBeUndefined();
  });

  it("rejects a factory outside the configured token scope", async () => {
    vi.spyOn(StandardTokenFactory.config, "view").mockResolvedValue({
      value: factoryConfig(0x44),
      height: 1n,
      events: [],
    });

    await expect(
      new GroundhogRegistrySource(client, scope).verifyScope(),
    ).rejects.toBeInstanceOf(RegistryScopeVerificationError);
  });

  it("decodes generated TokenCreated fields and rejects a wrong event hash", async () => {
    vi.spyOn(TokenCreated, "decode").mockReturnValue({
      name: "TokenCreated",
      topics: {
        token: address(0x44),
        creator: address(0x55),
      },
      fields: {
        administrator: address(0x66),
        initial_holder: address(0x77),
        initial_supply: 123n,
        name: "Token",
        symbol: "TOK",
        decimals: 7n,
        token_code_hash: fixedBytes(
          Uint8Array.from({ length: 32 }, () => 0x99),
          32,
        ),
      },
    });
    client.getEvents.mockResolvedValueOnce({
      events: [identifiedEvent()],
      cursor: new Uint8Array(),
      latestBlock: 8n,
      oldestBlock: 1n,
    });

    await expect(
      new GroundhogRegistrySource(client, scope).getPage({
        anchorBlock: "1",
        cursor: null,
        limit: 20,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);
  });

  it("maps canonical event identity and metadata into a registry token", async () => {
    vi.spyOn(TokenCreated, "decode").mockReturnValue({
      name: "TokenCreated",
      topics: { token: address(0x44), creator: address(0x55) },
      fields: {
        administrator: address(0x66),
        initial_holder: address(0x77),
        initial_supply: 123n,
        name: "Token",
        symbol: "TOK",
        decimals: 7n,
        token_code_hash: fixedBytes(
          Uint8Array.from({ length: 32 }, () => 0x33),
          32,
        ),
      },
    });
    client.getEvents.mockResolvedValueOnce({
      events: [identifiedEvent()],
      cursor: Uint8Array.of(1, 2, 3),
      latestBlock: 8n,
      oldestBlock: 2n,
    });

    const result = await new GroundhogRegistrySource(client, scope).getPage({
      anchorBlock: "2",
      cursor: null,
      limit: 20,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      nextCursor: "AQID",
      latestBlock: "8",
      oldestBlock: "2",
      tokens: [
        {
          tokenAddress: `0x${"44".repeat(32)}`,
          creatorAddress: `0x${"55".repeat(32)}`,
          initialSupply: "123",
          transactionHash: `0x${"88".repeat(32)}`,
          eventSequence: 0,
          blockHeight: "8",
          name: "Token",
          symbol: "TOK",
          decimals: 7,
        },
      ],
    });
    expect(client.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ order: "ascending", anchor: { height: 2n } }),
    );
  });

  it("classifies only invalid supplied cursors as cursor rejection", async () => {
    client.getEvents.mockRejectedValueOnce(
      new JsonRpcError(GroundhogRpcErrorCode.InvalidParams, "invalid cursor"),
    );
    const source = new GroundhogRegistrySource(client, scope);

    await expect(
      source.getPage({
        anchorBlock: "1",
        cursor: "AQID",
        limit: 20,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RegistryCursorRejectedError);

    client.getEvents.mockRejectedValueOnce(new Error("temporary outage"));
    await expect(
      source.getPage({
        anchorBlock: "1",
        cursor: "AQID",
        limit: 20,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("temporary outage");
  });

  it("passes the request abort signal to the event requester", async () => {
    const controller = new AbortController();
    const getEvents = vi.fn().mockRejectedValue(new Error("aborted"));
    const source = new GroundhogRegistrySource(client, scope, getEvents);

    await source
      .getPage({
        anchorBlock: "1",
        cursor: null,
        limit: 20,
        signal: controller.signal,
      })
      .catch(() => undefined);

    expect(getEvents).toHaveBeenCalledWith(
      expect.any(Object),
      controller.signal,
    );
  });
});

function factoryConfig(byte: number) {
  return {
    token_code_hash: fixedBytes(
      Uint8Array.from({ length: 32 }, () => byte),
      32,
    ),
    required_token_funding: 1n,
    native_token: address(0),
    creation_fee: 0n,
    fee_recipient: null,
  };
}

function identifiedEvent() {
  return {
    txHash: hashFromHex(`0x${"88".repeat(32)}`),
    blockHeight: 8n,
    sequenceNumber: 0,
    event: {
      contractAddress: address(0x22),
      topics: [],
      data: new Uint8Array(),
    },
  };
}

function address(byte: number) {
  return addressFromHex(`0x${byte.toString(16).padStart(2, "0").repeat(32)}`);
}
