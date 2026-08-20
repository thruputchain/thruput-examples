import {
  contractAddress,
  ExecResult,
  sha256Hash,
  type ContractAddress,
} from "@groundhogchain/protocol";
import { CxsWriter, FixedArrayCodec, Uint128Codec } from "@groundhogchain/xdr";
import type { GroundhogClient } from "@groundhogchain/client";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { RequestFailed } from "@/contracts/generated/swap-driver";
import { SwapEvent } from "@/contracts/generated/swap-pair";
import type { OutstandingRequest } from "@/transactions/outstanding-request";
import {
  createRequestRecord,
  type RequestRecord,
} from "@/transactions/request-collection";
import {
  applyObservationBatch,
  createRequestObserver,
  observationsFromReceipt,
} from "./request-observer";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  pairAddress: address(7),
  handlerAddress: address(6),
  driverAddress: address(5),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenDecimals: 6,
};
const request: OutstandingRequest = {
  status: "queued",
  phase: "swap",
  intent: { amountIn: 10n, amountOutMin: 18n },
  transactionHash: hex(0xaa),
  receiptBlock: 8n,
  requestId: hex(0xcc),
  visibleObservationMs: 0,
  observationBaseline: null,
  criteria: {
    pairAddress: hex(7),
    handlerAddress: hex(6),
    driverAddress: hex(5),
    recipient: hex(9),
    tokenIn: hex(1),
    tokenOut: hex(2),
  },
};

function rpcClient(
  getEvents: Pick<GroundhogClient, "getEvents">["getEvents"],
): Pick<GroundhogClient, "getEvents"> {
  return { getEvents };
}

describe("request observer", () => {
  it("walks cursors and strictly matches a successful swap by request ID", async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(page([], new Uint8Array([1]), 9n))
      .mockResolvedValueOnce(
        page([identified(swapEvent(new Uint8Array(32).fill(0xcc)), 10n)], new Uint8Array(), 10n),
      );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).resolves.toEqual({
      kind: "executionObserved",
      requestId: request.requestId,
      transactionHash: hex(0xdd),
      blockHeight: 10n,
      amountIn: 10n,
      amountOut: 19n,
    });
    expect(getEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        order: "ascending",
        anchor: { height: 8n },
        limit: 200,
      }),
    );
    expect(getEvents.mock.calls[1]?.[0].cursor).toEqual(new Uint8Array([1]));
  });

  it("ignores identical amounts with another request ID", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [identified(swapEvent(new Uint8Array(32).fill(0xee)), 10n)],
        new Uint8Array(),
        10n,
      ),
    );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).resolves.toBeNull();
  });

  it("matches a terminal RequestFailed event", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [
          identified(
            {
              contractAddress: config.driverAddress,
              topics: [
                RequestFailed.signature,
                new Uint8Array(32).fill(0xcc),
              ],
              data: new Uint8Array(),
            },
            11n,
          ),
        ],
        new Uint8Array(),
        11n,
      ),
    );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).resolves.toMatchObject({
      kind: "executionFailed",
      blockHeight: 11n,
    });
  });

  it.each([
    ["pair", { contractAddress: address(4) }, request],
    ["handler", { sender: address(4) }, request],
    ["recipient", { recipient: address(4) }, request],
    ["exact input", { amountIn: 11n }, request],
    ["minimum output", { amountOut: 17n }, request],
    [
      "direction",
      {},
      {
        ...request,
        criteria: {
          ...request.criteria,
          tokenIn: request.criteria.tokenOut,
          tokenOut: request.criteria.tokenIn,
        },
      },
    ],
  ])("rejects a swap with the wrong %s", async (_name, options, candidate) => {
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [identified(swapEvent(new Uint8Array(32).fill(0xcc), options), 10n)],
        new Uint8Array(),
        10n,
      ),
    );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(candidate),
    ).resolves.toBeNull();
  });

  it("accepts a matching event at the enqueue receipt block", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [identified(swapEvent(new Uint8Array(32).fill(0xcc)), 8n)],
        new Uint8Array(),
        8n,
      ),
    );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).resolves.toEqual({
      kind: "executionObserved",
      requestId: request.requestId,
      transactionHash: hex(0xdd),
      blockHeight: 8n,
      amountIn: 10n,
      amountOut: 19n,
    });
  });

  it("rejects an event before the enqueue receipt block", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [identified(swapEvent(new Uint8Array(32).fill(0xcc)), 7n)],
        new Uint8Array(),
        8n,
      ),
    );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).resolves.toBeNull();
  });

  it("rejects repeated cursors instead of looping forever", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page([], new Uint8Array([1]), 9n),
    );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).rejects.toThrow("repeated pagination cursor");
  });

  it("reports unavailable retained history so fallback observation can run", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      ...page([], new Uint8Array(), 20n),
      oldestBlock: 10n,
    });

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).rejects.toThrow("history no longer covers");
  });

  it("observes multiple terminal outcomes in one paginated scan", async () => {
    const first = record(request, "first");
    const second = record(
      {
        ...request,
        transactionHash: hex(0xbb),
        receiptBlock: 9n,
        requestId: hex(0xee),
      },
      "second",
    );
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [
          identified(swapEvent(new Uint8Array(32).fill(0xcc)), 10n, 1),
          identified(failedEvent(new Uint8Array(32).fill(0xee)), 10n, 2),
        ],
        new Uint8Array(),
        12n,
      ),
    );
    const observer = createRequestObserver(config, rpcClient(getEvents));

    await expect(observer.scanAll!([first, second])).resolves.toEqual({
      observations: [
        {
          kind: "executionObserved",
          requestId: first.requestId,
          transactionHash: hex(0xdd),
          blockHeight: 10n,
          amountIn: 10n,
          amountOut: 19n,
        },
        {
          kind: "executionFailed",
          requestId: second.requestId,
          transactionHash: hex(0xdd),
          blockHeight: 10n,
        },
      ],
      observedThroughBlock: 12n,
    });
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getEvents.mock.calls[0]?.[0]).toMatchObject({
      anchor: { height: 8n },
    });
    expect(getEvents.mock.calls[0]?.[0].filters[1].topics.topic1).toBeUndefined();
  });

  it("resumes from the earliest persisted observation watermark", async () => {
    const first = { ...record(request, "first"), observedThroughBlock: 12n };
    const second = {
      ...record({ ...request, requestId: hex(0xee) }, "second"),
      observedThroughBlock: 10n,
    };
    const getEvents = vi.fn().mockResolvedValue(page([], new Uint8Array(), 12n));

    await createRequestObserver(config, rpcClient(getEvents)).scanAll!([
      first,
      second,
    ]);

    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ anchor: { height: 10n } }),
    );
  });

  it("accepts retention beginning after a completed watermark", async () => {
    const observed = { ...record(request, "first"), observedThroughBlock: 10n };
    const getEvents = vi.fn().mockResolvedValue({
      ...page([], new Uint8Array(), 12n),
      oldestBlock: 11n,
    });

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scanAll!([observed]),
    ).resolves.toMatchObject({ observedThroughBlock: 12n });
  });

  it("applies a batch only to scanned records and is idempotent", () => {
    const first = record(request, "first");
    const second = record(
      { ...request, requestId: hex(0xee) },
      "second",
    );
    const insertedDuringScan = record(
      { ...request, requestId: hex(0xff) },
      "new",
    );
    const batch = {
      observations: [
        {
          kind: "executionObserved" as const,
          requestId: first.requestId!,
          transactionHash: hex(0xdd),
          blockHeight: 10n,
          amountIn: 10n,
          amountOut: 19n,
        },
      ],
      observedThroughBlock: 12n,
    };

    const applied = applyObservationBatch(
      [first, second, insertedDuringScan],
      [first, second],
      batch,
      20,
    );

    expect(applied[0]).toMatchObject({
      status: "executed",
      updatedAt: 20,
      observedThroughBlock: 12n,
      execution: { kind: "executed", amountOut: 19n },
    });
    expect(applied[1]).toMatchObject({
      status: "queued",
      observedThroughBlock: 12n,
    });
    expect(applied[2]).toEqual(insertedDuringScan);
    expect(applyObservationBatch(applied, [first, second], batch, 30)).toEqual(
      applied,
    );
  });

  it("strictly correlates every terminal event in one crank receipt", () => {
    const first = { ...record(request, "first"), observedThroughBlock: 9n };
    const second = record(
      { ...request, requestId: hex(0xee) },
      "second",
    );
    const receipt = {
      txHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
      height: 10n,
      execResult: ExecResult.ExecResultOK,
      events: [
        swapEvent(new Uint8Array(32).fill(0xcc)),
        failedEvent(new Uint8Array(32).fill(0xee)),
      ],
      returnData: new Uint8Array(),
      abortData: null,
    };

    const batch = observationsFromReceipt(config, [first, second], receipt);
    const applied = applyObservationBatch([first, second], [first, second], batch, 20);

    expect(batch.observations.map(({ kind }) => kind)).toEqual([
      "executionObserved",
      "executionFailed",
    ]);
    expect(batch.observedThroughBlock).toBeNull();
    expect(applied.map(({ status }) => status)).toEqual(["executed", "failed"]);
    expect(applied[0]?.observedThroughBlock).toBe(9n);
  });

  it("rejects duplicate terminal events without partially applying them", () => {
    const queued = record(request, "first");
    const event = failedEvent(new Uint8Array(32).fill(0xcc));
    const receipt = {
      txHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
      height: 10n,
      execResult: ExecResult.ExecResultOK,
      events: [event, event],
      returnData: new Uint8Array(),
      abortData: null,
    };

    expect(() => observationsFromReceipt(config, [queued], receipt)).toThrow(
      "duplicate terminal request events",
    );
    expect(queued.status).toBe("queued");
  });
});

function swapEvent(
  requestId: Uint8Array,
  options: {
    contractAddress?: ContractAddress;
    sender?: Uint8Array;
    recipient?: Uint8Array;
    amountIn?: bigint;
    amountOut?: bigint;
  } = {},
) {
  const amounts = FixedArrayCodec(Uint128Codec, 2);
  const writer = new CxsWriter();
  amounts.encode(writer, [options.amountIn ?? 10n, 0n]);
  amounts.encode(writer, [0n, options.amountOut ?? 19n]);
  writer.writeUint32(1n);
  writer.writeFixedOpaque(requestId, 32);
  return {
    contractAddress: options.contractAddress ?? config.pairAddress,
    topics: [
      SwapEvent.signature,
      options.sender ?? config.handlerAddress,
      options.recipient ?? config.accountAddress,
    ],
    data: writer.finish(),
  };
}

function failedEvent(requestId: Uint8Array) {
  return {
    contractAddress: config.driverAddress,
    topics: [RequestFailed.signature, requestId],
    data: new Uint8Array(),
  };
}

function identified(
  event: ReturnType<typeof swapEvent> | ReturnType<typeof failedEvent>,
  blockHeight: bigint,
  sequenceNumber = 1,
) {
  return {
    txHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
    blockHeight,
    sequenceNumber,
    event,
  };
}

function page(
  events: ReturnType<typeof identified>[],
  cursor: Uint8Array,
  latestBlock: bigint,
) {
  return { events, cursor, latestBlock, oldestBlock: 1n };
}

function record(value: OutstandingRequest, localId: string): RequestRecord {
  return createRequestRecord(value, { localId, now: 1 });
}
