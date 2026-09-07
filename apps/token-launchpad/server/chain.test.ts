// @vitest-environment node

import {
  addressFromHex,
  fixedBytes,
  GroundhogRpcErrorCode,
  hashFromHex,
  JsonRpcError,
} from "@groundhogchain/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GroundhogRegistrySource,
  RegistryCursorRejectedError,
  RegistryIntegrityError,
  RegistryScopeVerificationError,
} from "./chain.ts";
import type { RegistryScope } from "./domain.ts";
import {
  StandardTokenFactory,
  TokenCreated,
} from "../src/contracts/generated/standard-token-factory.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: `0x${"22".repeat(32)}`,
  tokenCodeHash: `0x${"33".repeat(32)}`,
};
const client = { view: vi.fn(), getEvents: vi.fn() };

afterEach(() => vi.restoreAllMocks());

describe("GroundhogRegistrySource", () => {
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
