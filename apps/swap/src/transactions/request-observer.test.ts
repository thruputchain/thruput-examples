import { toBase58, toHex0x } from "@thruputchain/client";
import {
  contractAddress,
  sha256Hash,
  type ContractAddress,
} from "@thruputchain/protocol";
import { CxsWriter, FixedArrayCodec, Uint128Codec } from "@thruputchain/xdr";
import type { ThruputClient } from "@thruputchain/client";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { batch_driver } from "@/contracts/generated/swap-driver";
import { requestFailedEvent } from "@/test/request-failed";
import { swap_if } from "@/contracts/generated/swap-handler";
import type { OutstandingRequest } from "@/transactions/request-collection";
import {
  createRequestRecord,
  loadRequestCollection,
  saveRequestCollection,
  type RequestRecord,
} from "@/transactions/request-collection";
import {
  applyObservationBatch,
  createRequestObserver,
  observationsFromReceipt,
} from "./request-observer";

const Cause = batch_driver.v0_1.events.Cause;
type Cause = batch_driver.v0_1.events.Cause;
const RequestFailed = batch_driver.v0_1.events.RequestFailed;
type RequestFailed = batch_driver.v0_1.events.RequestFailed;
const SwapEvent = swap_if.v0_1.events.SwapEvent;
type SwapEvent = swap_if.v0_1.events.SwapEvent;

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) =>
  `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(10),
  nativeHogAddress: address(11),
  liquidityTokenAddress: address(12),
  handlerAddress: address(6),
  driverAddress: address(5),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
};
const request: OutstandingRequest = {
  status: "queued",
  phase: "swap",
  intent: { amountIn: 10n, amountOutMin: 18n },
  transactionHash: id(0xaa),
  receiptBlock: 8n,
  requestId: hex(0xcc),
  visibleObservationMs: 0,
  observationBaseline: null,
  criteria: {
    handlerAddress: id(6),
    driverAddress: id(5),
    sender: id(9),
    recipient: id(9),
    tokenIn: id(1),
    tokenOut: id(2),
  },
};

function rpcClient(
  getEvents: Pick<ThruputClient, "getEvents">["getEvents"],
): Pick<ThruputClient, "getEvents"> {
  return { getEvents };
}

describe("request observer", () => {
  it("walks cursors and strictly matches a successful swap by request ID", async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(page([], new Uint8Array([1]), 9n))
      .mockResolvedValueOnce(
        page(
          [identified(swapEvent(new Uint8Array(32).fill(0xcc)), 10n)],
          new Uint8Array(),
          10n,
        ),
      );

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).resolves.toEqual({
      kind: "executionObserved",
      requestId: request.requestId,
      transactionHash: id(0xdd),
      blockHeight: 10n,
      amountIn: 10n,
      amountOut: 19n,
    });
    expect(getEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        start: {
          order: "ascending",
          anchor: { kind: "atHeight", blockHeight: 8n },
        },
        limit: 200,
      }),
    );
    expect(getEvents.mock.calls[1]?.[0].cursor).toBe("0x01");
  });

  it("ignores identical amounts with another request ID", async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValue(
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

  it.each(Object.values(Cause))(
    "matches a terminal RequestFailed with cause %s",
    async (cause) => {
      const fields = {
        cause,
        selector: cause === Cause.Exception ? 0xb19947acb2fa14ffn : 0n,
        payload:
          cause === Cause.Exception
            ? new Uint8Array(256).fill(255)
            : new Uint8Array(),
        payload_len: cause === Cause.Exception ? 512n : 0n,
      };
      const event = requestFailedEvent(
        config.driverAddress,
        new Uint8Array(32).fill(0xcc),
        fields,
      );
      expect(RequestFailed.decode(event)?.fields).toEqual(fields);
      const getEvents = vi
        .fn()
        .mockResolvedValue(
          page([identified(event, 11n)], new Uint8Array(), 11n),
        );

      await expect(
        createRequestObserver(config, rpcClient(getEvents)).scan(request),
      ).resolves.toMatchObject({
        kind: "executionFailed",
        blockHeight: 11n,
      });
    },
  );

  it("preserves slippage reasons from polling and receipts through saved history", async () => {
    const queued = record(request, "slippage");
    const event = requestFailedEvent(
      config.driverAddress,
      new Uint8Array(32).fill(0xcc),
      {
        cause: Cause.Exception,
        selector: 0x947bdd51feea1ccen,
        payload: Uint8Array.of(3),
        payload_len: 1n,
      },
    );
    const getEvents = vi
      .fn()
      .mockResolvedValue(page([identified(event, 10n)], new Uint8Array(), 10n));
    const polled = await createRequestObserver(config, rpcClient(getEvents))
      .scanAll!([queued]);
    const receipt = observationsFromReceipt(config, [queued], {
      transactionHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
      blockHeight: 10n,
      execution: { result: "return" as const, returnData: new Uint8Array() },
      gasUsed: 0n,
      events: [event],
    });
    expect(polled.observations).toEqual(receipt.observations);
    expect(receipt.observations[0]).toMatchObject({
      kind: "executionFailed",
      failureMessage:
        "Slippage limit exceeded: output was below your minimum received amount.",
    });
    const applied = applyObservationBatch([queued], [queued], receipt);
    saveRequestCollection(config, applied);
    expect(loadRequestCollection(config)).toEqual(applied);
    localStorage.clear();
  });

  it("rejects a failure event without the required diagnostic fields", async () => {
    const event = {
      ...failedEvent(new Uint8Array(32).fill(0xcc)),
      data: new Uint8Array(),
    };
    const getEvents = vi
      .fn()
      .mockResolvedValue(page([identified(event, 11n)], new Uint8Array(), 11n));
    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).rejects.toThrow("Failed to decode RequestFailed");
    expect(request.status).toBe("queued");
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
    const getEvents = vi
      .fn()
      .mockResolvedValue(
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
    const getEvents = vi
      .fn()
      .mockResolvedValue(
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
      transactionHash: id(0xdd),
      blockHeight: 8n,
      amountIn: 10n,
      amountOut: 19n,
    });
  });

  it("rejects an event before the enqueue receipt block", async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValue(
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
    const getEvents = vi
      .fn()
      .mockResolvedValue(page([], new Uint8Array([1]), 9n));

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scan(request),
    ).rejects.toThrow("repeated pagination cursor");
  });

  it("reports unavailable retained history so fallback observation can run", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      ...page([], new Uint8Array(), 20n),
      oldestIndexedBlockHeight: 10n,
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
        transactionHash: id(0xbb),
        receiptBlock: 9n,
        requestId: hex(0xee),
      },
      "second",
    );
    const getEvents = vi
      .fn()
      .mockResolvedValue(
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
          transactionHash: id(0xdd),
          blockHeight: 10n,
          amountIn: 10n,
          amountOut: 19n,
        },
        {
          kind: "executionFailed",
          requestId: second.requestId,
          transactionHash: id(0xdd),
          blockHeight: 10n,
        },
      ],
      observedThroughBlock: 12n,
    });
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getEvents.mock.calls[0]?.[0]).toMatchObject({
      start: {
        order: "ascending",
        anchor: { kind: "atHeight", blockHeight: 8n },
      },
    });
    expect(
      getEvents.mock.calls[0]?.[0].filters[1].topics.topic1,
    ).toBeUndefined();
  });

  it("resumes from the earliest persisted observation watermark", async () => {
    const first = { ...record(request, "first"), observedThroughBlock: 12n };
    const second = {
      ...record({ ...request, requestId: hex(0xee) }, "second"),
      observedThroughBlock: 10n,
    };
    const getEvents = vi
      .fn()
      .mockResolvedValue(page([], new Uint8Array(), 12n));

    await createRequestObserver(config, rpcClient(getEvents)).scanAll!([
      first,
      second,
    ]);

    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        start: {
          order: "ascending",
          anchor: { kind: "atHeight", blockHeight: 10n },
        },
      }),
    );
  });

  it("accepts retention beginning after a completed watermark", async () => {
    const observed = { ...record(request, "first"), observedThroughBlock: 10n };
    const getEvents = vi.fn().mockResolvedValue({
      ...page([], new Uint8Array(), 12n),
      oldestIndexedBlockHeight: 11n,
    });

    await expect(
      createRequestObserver(config, rpcClient(getEvents)).scanAll!([observed]),
    ).resolves.toMatchObject({ observedThroughBlock: 12n });
  });

  it("applies a batch only to scanned records and is idempotent", () => {
    const first = record(request, "first");
    const second = record({ ...request, requestId: hex(0xee) }, "second");
    const insertedDuringScan = record(
      { ...request, requestId: hex(0xff) },
      "new",
    );
    const batch = {
      observations: [
        {
          kind: "executionObserved" as const,
          requestId: first.requestId!,
          transactionHash: id(0xdd),
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
    const second = record({ ...request, requestId: hex(0xee) }, "second");
    const receipt = {
      transactionHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
      blockHeight: 10n,
      execution: { result: "return" as const, returnData: new Uint8Array() },
      gasUsed: 0n,
      events: [
        swapEvent(new Uint8Array(32).fill(0xcc)),
        failedEvent(new Uint8Array(32).fill(0xee)),
      ],
    };

    const batch = observationsFromReceipt(config, [first, second], receipt);
    const applied = applyObservationBatch(
      [first, second],
      [first, second],
      batch,
      20,
    );

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
      transactionHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
      blockHeight: 10n,
      execution: { result: "return" as const, returnData: new Uint8Array() },
      gasUsed: 0n,
      events: [event, event],
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
    address: options.contractAddress ?? config.handlerAddress,
    topics: [
      SwapEvent.signature,
      options.sender ?? config.accountAddress,
      options.recipient ?? config.accountAddress,
    ],
    data: writer.finish(),
  };
}

function failedEvent(requestId: Uint8Array) {
  return requestFailedEvent(config.driverAddress, requestId);
}

function identified(
  event: ReturnType<typeof swapEvent> | ReturnType<typeof failedEvent>,
  blockHeight: bigint,
  sequenceNumber = 1,
) {
  return {
    transactionHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
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
  return {
    events,
    nextCursor: cursor.length ? toHex0x(cursor) : null,
    latestIndexedBlockHeight: latestBlock,
    oldestIndexedBlockHeight: 1n,
  };
}

function record(value: OutstandingRequest, localId: string): RequestRecord {
  return createRequestRecord(value, { localId, now: 1 });
}
