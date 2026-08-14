import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { saveOutstandingRequest } from "@/transactions/outstanding-request";
import {
  createRequestRecord,
  dismissTerminalRequest,
  loadRequestCollection,
  migrateRequestCollection,
  mutateRequestCollection,
  pruneRequestHistory,
  requestCollectionKey,
  RequestCollectionError,
  saveRequestCollection,
  type RequestRecord,
} from "./request-collection";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hash = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  pairAddress: address(2),
  handlerAddress: address(3),
  tokenAAddress: address(4),
  tokenBAddress: address(5),
  driverAddress: address(6),
} as AppConfig;
const criteria = {
  pairAddress: hash(2),
  handlerAddress: hash(3),
  driverAddress: hash(6),
  recipient: hash(1),
  tokenIn: hash(4),
  tokenOut: hash(5),
};

describe("request collection", () => {
  beforeEach(() => window.localStorage.clear());

  it("round trips multiple requests and bigint terminal data", () => {
    const queued = request("queued", "queued", 1);
    const executed: RequestRecord = {
      ...request("executed", "executed", 2),
      execution: {
        kind: "executed",
        transactionHash: hash(12),
        blockHeight: 30n,
        amountIn: 10n,
        amountOut: 9n,
      },
    };

    saveRequestCollection(config, [queued, executed]);

    expect(loadRequestCollection(config)).toEqual([queued, executed]);
  });

  it("migrates and removes the valid legacy singleton", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10n, amountOutMin: 9n },
      transactionHash: hash(10),
      receiptBlock: 12n,
      requestId: hash(11),
      visibleObservationMs: 500,
      observationBaseline: null,
      criteria,
    });

    const [migrated] = await migrateRequestCollection(config);

    expect(migrated).toMatchObject({
      localId: "legacy-outstanding-request",
      status: "queued",
      intent: { amountIn: 10n, amountOutMin: 9n },
      requestId: hash(11),
    });
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem(requestCollectionKey(config))).not.toBeNull();
  });

  it("serializes migration with collection mutations", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10n, amountOutMin: 9n },
      transactionHash: hash(10),
      receiptBlock: 12n,
      requestId: hash(11),
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    const restoreLocks = installSerialLocks();

    try {
      await Promise.all([
        migrateRequestCollection(config),
        mutateRequestCollection(config, (current) => [
          ...current,
          request("new-request", "queued", 2),
        ]),
      ]);
    } finally {
      restoreLocks();
    }

    expect(loadRequestCollection(config).map(({ localId }) => localId)).toEqual([
      "legacy-outstanding-request",
      "new-request",
    ]);
  });

  it("reconciles a new legacy-tab request after initial migration", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10n, amountOutMin: 9n },
      transactionHash: hash(10),
      receiptBlock: 12n,
      requestId: hash(11),
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    await migrateRequestCollection(config);
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 5n, amountOutMin: 4n },
      transactionHash: hash(20),
      receiptBlock: 13n,
      requestId: hash(21),
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });

    const reconciled = await migrateRequestCollection(config);

    expect(reconciled).toHaveLength(2);
    expect(reconciled.map(({ requestId }) => requestId)).toEqual([
      hash(11),
      hash(21),
    ]);
  });

  it("preserves legacy storage when migration cannot be written", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10n, amountOutMin: 9n },
      transactionHash: hash(10),
      receiptBlock: 12n,
      requestId: hash(11),
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(
      () => {
        throw new DOMException("storage full", "QuotaExceededError");
      },
    );

    try {
      await expect(migrateRequestCollection(config)).rejects.toThrow("storage full");
    } finally {
      setItem.mockRestore();
    }
    expect(loadRequestCollection(config)).toEqual([]);
    expect(await migrateRequestCollection(config)).toHaveLength(1);
  });

  it("fails closed without deleting malformed storage", () => {
    const stored = JSON.parse(
      JSON.stringify(saveAndReadRaw([request("queued", "queued", 1)])),
    );
    stored.requests[0].criteria.tokenOut = hash(99);
    window.localStorage.setItem(requestCollectionKey(config), JSON.stringify(stored));

    expect(() => loadRequestCollection(config)).toThrow(RequestCollectionError);
    expect(window.localStorage.getItem(requestCollectionKey(config))).not.toBeNull();
  });

  it("rejects zero-valued persisted intent", () => {
    const stored = JSON.parse(
      JSON.stringify(saveAndReadRaw([request("queued", "queued", 1)])),
    );
    stored.requests[0].amountIn = "0";
    window.localStorage.setItem(requestCollectionKey(config), JSON.stringify(stored));

    expect(() => loadRequestCollection(config)).toThrow(RequestCollectionError);
  });

  it("rejects duplicate request IDs and inconsistent execution data", () => {
    const first = request("first", "queued", 1);
    const second = { ...request("second", "queued", 2), requestId: first.requestId };
    expect(() => saveRequestCollection(config, [first, second])).toThrow(
      RequestCollectionError,
    );

    const executed: RequestRecord = {
      ...request("executed", "executed", 3),
      execution: {
        kind: "executed",
        transactionHash: hash(13),
        blockHeight: 23n,
        amountIn: 9n,
        amountOut: 9n,
      },
    };
    expect(() => saveRequestCollection(config, [executed])).toThrow(
      RequestCollectionError,
    );
  });

  it("serializes atomic mutations and retains both updates", async () => {
    const restoreLocks = installSerialLocks();

    try {
      await Promise.all([
        mutateRequestCollection(config, (current) => [
          ...current,
          request("queued-1", "queued", 1),
        ]),
        mutateRequestCollection(config, (current) => [
          ...current,
          request("queued-2", "queued", 2),
        ]),
      ]);
    } finally {
      restoreLocks();
    }

    expect(loadRequestCollection(config).map(({ localId }) => localId)).toEqual([
      "queued-1",
      "queued-2",
    ]);
  });

  it("keeps unresolved requests and the newest 50 terminal requests", () => {
    const unresolved = request("pending", "queued", 1);
    const terminal = Array.from({ length: 52 }, (_, index) =>
      request(`terminal-${index}`, "failed", index + 2)
    );

    const pruned = pruneRequestHistory([unresolved, ...terminal]);

    expect(pruned).toHaveLength(51);
    expect(pruned[0]).toEqual(unresolved);
    expect(pruned.some(({ localId }) => localId === "terminal-0")).toBe(false);
    expect(pruned.some(({ localId }) => localId === "terminal-51")).toBe(true);
  });

  it("dismisses only terminal requests", () => {
    const queued = request("queued", "queued", 1);
    const failed = request("failed", "failed", 2);
    const committedFailure: RequestRecord = {
      ...request("committed", "queued", 3),
      status: "committedFailure",
      receiptBlock: null,
      requestId: null,
    };

    expect(dismissTerminalRequest([queued, failed], "queued")).toEqual([
      queued,
      failed,
    ]);
    expect(dismissTerminalRequest([queued, failed], "failed")).toEqual([queued]);
    expect(
      dismissTerminalRequest([queued, committedFailure], "committed"),
    ).toEqual([queued]);
  });
});

function request(
  localId: string,
  status: RequestRecord["status"],
  order: number,
): RequestRecord {
  const terminal = status === "failed"
    ? {
        kind: "failed" as const,
        transactionHash: hash(order + 10),
        blockHeight: BigInt(order + 20),
      }
    : null;
  return {
    ...createRequestRecord(
      {
        status: status === "executed" || status === "failed" ? "queued" : status,
        phase: "swap",
        intent: { amountIn: 10n, amountOutMin: 9n },
        transactionHash: hash(order + 10),
        receiptBlock: BigInt(order + 20),
        requestId: hash(order + 30),
        visibleObservationMs: 0,
        observationBaseline: null,
        criteria,
      },
      { localId, now: order },
    ),
    status,
    execution: terminal,
  };
}

function installSerialLocks(): () => void {
  const originalLocks = window.navigator.locks;
  let tail = Promise.resolve();
  Object.defineProperty(window.navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T> | T,
      ) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    },
  });
  return () => {
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: originalLocks,
    });
  };
}

function saveAndReadRaw(requests: RequestRecord[]): unknown {
  saveRequestCollection(config, requests);
  return JSON.parse(window.localStorage.getItem(requestCollectionKey(config))!);
}
