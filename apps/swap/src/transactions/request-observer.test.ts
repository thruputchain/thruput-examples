import { contractAddress, sha256Hash } from "@groundhogchain/protocol";
import { CxsWriter, FixedArrayCodec, Uint128Codec } from "@groundhogchain/xdr";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import {
  REQUEST_FAILED_SIGNATURE,
  SWAP_EVENT_SIGNATURE,
} from "@/contracts/swap-event";
import type { OutstandingRequest } from "@/transactions/outstanding-request";
import { createRequestObserver } from "./request-observer";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: 0n,
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

describe("request observer", () => {
  it("walks cursors and strictly matches a successful swap by request ID", async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(page([], new Uint8Array([1]), 9n))
      .mockResolvedValueOnce(
        page([identified(swapEvent(new Uint8Array(32).fill(0xcc)), 10n)], new Uint8Array(), 10n),
      );

    await expect(
      createRequestObserver(config, { getEvents }).scan(request),
    ).resolves.toEqual({
      result: {
        kind: "executionObserved",
        requestId: request.requestId,
        transactionHash: hex(0xdd),
        blockHeight: 10n,
        amountIn: 10n,
        amountOut: 19n,
      },
      latestBlock: 10n,
    });
    expect(getEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        order: "ascending",
        anchor: { height: 9n },
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
      createRequestObserver(config, { getEvents }).scan(request),
    ).resolves.toEqual({ result: null, latestBlock: 10n });
  });

  it("matches a terminal RequestFailed event", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [
          identified(
            {
              contractAddress: config.driverAddress,
              topics: [
                REQUEST_FAILED_SIGNATURE,
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
      createRequestObserver(config, { getEvents }).scan(request),
    ).resolves.toMatchObject({
      result: { kind: "executionFailed", blockHeight: 11n },
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
      createRequestObserver(config, { getEvents }).scan(candidate),
    ).resolves.toEqual({ result: null, latestBlock: 10n });
  });

  it("rejects an event at the enqueue receipt block", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page(
        [identified(swapEvent(new Uint8Array(32).fill(0xcc)), 8n)],
        new Uint8Array(),
        8n,
      ),
    );

    await expect(
      createRequestObserver(config, { getEvents }).scan(request),
    ).resolves.toEqual({ result: null, latestBlock: 8n });
  });

  it("rejects repeated cursors instead of looping forever", async () => {
    const getEvents = vi.fn().mockResolvedValue(
      page([], new Uint8Array([1]), 9n),
    );

    await expect(
      createRequestObserver(config, { getEvents }).scan(request),
    ).rejects.toThrow("repeated pagination cursor");
  });

  it("reports unavailable retained history so fallback observation can run", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      ...page([], new Uint8Array(), 20n),
      oldestBlock: 10n,
    });

    await expect(
      createRequestObserver(config, { getEvents }).scan(request),
    ).rejects.toThrow("history no longer covers");
  });
});

function swapEvent(
  requestId: Uint8Array,
  options: {
    contractAddress?: Uint8Array;
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
      SWAP_EVENT_SIGNATURE,
      options.sender ?? config.handlerAddress,
      options.recipient ?? config.accountAddress,
    ],
    data: writer.finish(),
  };
}

function identified(event: ReturnType<typeof swapEvent>, blockHeight: bigint) {
  return {
    txHash: sha256Hash(new Uint8Array(32).fill(0xdd)),
    blockHeight,
    sequenceNumber: 1,
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
