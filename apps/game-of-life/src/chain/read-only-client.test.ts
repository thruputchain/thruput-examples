import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReadAppConfig } from "@/config";
import {
  createReadOnlyClient,
  MalformedRpcResponseError,
} from "./read-only-client";

const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  rpcProxyPath: "/groundhog-rpc",
  networkId: "aa".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
  indexerUrl: new URL("http://127.0.0.1:8787"),
  indexerProxyPath: "/groundhog-indexer/",
} satisfies ReadAppConfig;

afterEach(() => vi.unstubAllGlobals());

describe("read-only Groundhog client", () => {
  test("serializes and validates contract views without a full wallet client", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    stubRpc(requests, {
      output: { result: "return", returnData: "0x0102" },
      events: [],
      height: "9",
    });
    const client = createReadOnlyClient(config);
    const result = await client.view({
      contract: new Uint8Array(32) as never,
      entrypoint: new Uint8Array(8) as never,
      calldata: new Uint8Array([3, 4]) as never,
    });
    expect(result.output).toEqual({
      result: "return",
      returnData: new Uint8Array([1, 2]),
    });
    expect(result.height).toBe(9n);
    expect(requests).toEqual([
      {
        method: "groundhog_view",
        params: [
          {
            contract: `0x${"00".repeat(32)}`,
            entrypoint: `0x${"00".repeat(8)}`,
            calldata: "0x0304",
          },
        ],
      },
    ]);
  });

  test("parses bounded event pages and rejects malformed event bytes", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const event = {
      txHash: `0x${"11".repeat(32)}`,
      blockHeight: "12",
      sequenceNumber: 3,
      event: {
        contractAddress: `0x${"22".repeat(32)}`,
        topics: [`0x${"33".repeat(32)}`],
        data: "0x0405",
      },
    };
    stubRpc(requests, {
      events: [event],
      cursor: "0xaabb",
      latestBlock: "15",
      oldestBlock: "2",
    });
    const client = createReadOnlyClient(config);
    const page = await client.getEvents({
      filters: [
        {
          contractAddresses: [new Uint8Array(32) as never],
          topics: { topic0: [new Uint8Array(32).fill(3)] },
        },
      ],
      anchor: { height: 10n },
      order: "ascending",
      limit: 20,
    });
    expect(page.events[0]).toMatchObject({
      blockHeight: 12n,
      sequenceNumber: 3,
    });
    expect(page.events[0]!.event.data).toEqual(new Uint8Array([4, 5]));
    expect(page.cursor).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(requests[0]).toMatchObject({
      method: "groundhog_getEvents",
      params: [
        {
          anchor: { kind: "atHeight", height: 10 },
          order: "ascending",
          limit: 20,
        },
      ],
    });

    stubRpc([], {
      events: [
        {
          ...event,
          event: { ...event.event, topics: ["0x01"] },
        },
      ],
      cursor: "0x",
      latestBlock: "15",
      oldestBlock: "2",
    });
    await expect(
      createReadOnlyClient(config).getEvents({ filters: [] }),
    ).rejects.toThrow("topic 0 must be 32 bytes");
  });

  test.each([
    {
      output: { result: "return", returnData: "0x" },
      events: "not-an-array",
      height: "9",
    },
    {
      output: { result: "unknown" },
      events: [],
      height: "9",
    },
    {
      output: { result: "return", returnData: "0x" },
      events: [],
      height: "9.5",
    },
  ])("classifies malformed view response %#", async (result) => {
    stubRpc([], result);
    await expect(
      createReadOnlyClient(config).view({
        contract: new Uint8Array(32) as never,
        entrypoint: new Uint8Array(8) as never,
        calldata: new Uint8Array() as never,
      }),
    ).rejects.toBeInstanceOf(MalformedRpcResponseError);
  });

  test.each([
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ])("classifies malformed JSON-RPC envelope %#", async (response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response.clone()) satisfies typeof fetch,
    );
    await expect(
      createReadOnlyClient(config).view({
        contract: new Uint8Array(32) as never,
        entrypoint: new Uint8Array(8) as never,
        calldata: new Uint8Array() as never,
      }),
    ).rejects.toBeInstanceOf(MalformedRpcResponseError);
  });
});

function stubRpc(
  requests: Array<{ method: string; params: unknown[] }>,
  result: unknown,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: string | number;
        method: string;
        params: unknown[];
      };
      requests.push({ method: request.method, params: request.params });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) satisfies typeof fetch,
  );
}
