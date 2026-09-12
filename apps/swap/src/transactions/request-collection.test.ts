import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import type { OutstandingRequest } from "@/transactions/outstanding-request";
import {
  createRequestRecord,
  loadAccountRequestRecords,
  loadRequestCollection,
  mutateRequestCollection,
  requestCollectionKey,
  saveRequestCollection,
  type RequestRecord,
} from "./request-collection";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
  liquidityTokenAddress: address(5),
  handlerAddress: address(6),
  driverAddress: address(7),
  tokenAAddress: address(8),
  tokenBAddress: address(9),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
} satisfies AppConfig;

describe("request collection", () => {
  beforeEach(() => window.localStorage.clear());

  it("round trips handler-scoped records", () => {
    const record = createRequestRecord(request(), { localId: "request-1", now: 1 });
    saveRequestCollection(config, [record]);

    expect(requestCollectionKey(config)).toContain("groundhog-swap:requests:v4");
    expect(loadRequestCollection(config)).toEqual([record]);
  });

  it.each([undefined, "Slippage limit exceeded."])(
    "loads failed history with reason %s",
    (failureMessage) => {
      const record: RequestRecord = {
        ...createRequestRecord(request(), { localId: "failed", now: 1 }),
        status: "failed",
        execution: {
          kind: "failed",
          transactionHash: hex(22),
          blockHeight: 13n,
          ...(failureMessage === undefined ? {} : { failureMessage }),
        },
      };
      saveRequestCollection(config, [record]);
      expect(loadRequestCollection(config)).toEqual([record]);
      expect(loadAccountRequestRecords(config)).toEqual([record]);

      const stored = JSON.parse(localStorage.getItem(requestCollectionKey(config))!);
      stored.requests[0].execution.failureMessage = { invalid: true };
      localStorage.setItem(requestCollectionKey(config), JSON.stringify(stored));
      expect(() => loadRequestCollection(config)).toThrow("Stored swap request history is invalid");
    },
  );

  it("loads current records across pools for account exposure", () => {
    const other = {
      ...config,
      factoryAddress: address(10),
      handlerAddress: address(11),
      driverAddress: address(12),
    };
    saveRequestCollection(config, [createRequestRecord(request(), { localId: "first", now: 1 })]);
    saveRequestCollection(other, [createRequestRecord(request({
      handlerAddress: hex(11),
      driverAddress: hex(12),
    }), { localId: "second", now: 2 })]);

    expect(loadAccountRequestRecords(config).map(({ localId }) => localId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("ignores retired and malformed namespaces without deleting them", () => {
    const oldKeys = [
      "groundhog-swap:requests:v3:old",
      "groundhog-swap:requests:v2:old",
      "groundhog-swap:outstanding:v1:old",
    ];
    for (const key of oldKeys) window.localStorage.setItem(key, "not-json");

    expect(loadAccountRequestRecords(config)).toEqual([]);
    expect(oldKeys.every((key) => window.localStorage.getItem(key) === "not-json")).toBe(true);
  });

  it("serializes mutations with the account lock", async () => {
    await mutateRequestCollection(config, () => [
      createRequestRecord(request(), { localId: "request-1", now: 1 }),
    ]);
    await mutateRequestCollection(config, (current) => [
      ...current,
      createRequestRecord({ ...request(), requestId: hex(22) }, {
        localId: "request-2",
        now: 2,
      }),
    ]);

    expect(loadRequestCollection(config)).toHaveLength(2);
  });
});

function request(
  criteria: Partial<OutstandingRequest["criteria"]> = {},
): OutstandingRequest {
  return {
    status: "queued",
    phase: "swap",
    intent: { amountIn: 10n, amountOutMin: 9n },
    transactionHash: hex(20),
    receiptBlock: 12n,
    requestId: hex(21),
    visibleObservationMs: 0,
    observationBaseline: null,
    criteria: {
      handlerAddress: hex(6),
      driverAddress: hex(7),
      sender: hex(1),
      recipient: hex(1),
      tokenIn: hex(8),
      tokenOut: hex(9),
      ...criteria,
    },
  };
}
