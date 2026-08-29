import type { GroundhogClient } from "@groundhogchain/client";
import { describe, expect, test, vi } from "vitest";
import {
  applyCompletionBatch,
  observeCompletions,
  type CompletionBatch,
} from "./observer";
import type { TickRequestRecord } from "./records";

const contract = `0x${"22".repeat(32)}`;

describe("completion observer", () => {
  test("detects retention gaps without inventing a terminal outcome", async () => {
    const record = request();
    const client = {
      getEvents: vi.fn(async () => ({
        events: [],
        cursor: new Uint8Array(),
        oldestBlock: 9n,
        latestBlock: 12n,
      })),
    } as unknown as Pick<GroundhogClient, "getEvents">;
    const batch = await observeCompletions({
      client,
      contractAddress: contract,
      requests: [record],
    });
    const [updated] = applyCompletionBatch([record], [record], batch);
    expect(updated?.status).toBe("completionUnknown");
    expect(updated?.diagnostic).toMatch(/permanently unknown/);
  });

  test("applies completion strictly by request ID and requester", () => {
    const record = request();
    const batch: CompletionBatch = {
      observations: [
        {
          requestId: record.requestId!,
          requester: record.requester,
          transactionHash: `0x${"88".repeat(32)}`,
          blockHeight: "12",
          generation: "1",
          population: "27336807",
          stateDigest: `0x${"99".repeat(32)}`,
        },
      ],
      observedThroughBlock: "12",
      retentionGapRequestIds: new Set(),
    };
    expect(applyCompletionBatch([record], [record], batch)[0]).toMatchObject({
      status: "advanced",
      resultingGeneration: "1",
      advancedTransactionHash: `0x${"88".repeat(32)}`,
    });
  });

  test("watermarks only through the first page's confirmed terminal block", async () => {
    const cursor = new Uint8Array([1]);
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce({
        events: [],
        cursor,
        oldestBlock: 0n,
        latestBlock: 10n,
      })
      .mockResolvedValueOnce({
        events: [],
        cursor: new Uint8Array(),
        oldestBlock: 0n,
        latestBlock: 12n,
      });
    const batch = await observeCompletions({
      client: { getEvents } as unknown as Pick<GroundhogClient, "getEvents">,
      contractAddress: contract,
      requests: [request()],
    });
    expect(batch.observedThroughBlock).toBe("10");
  });
});

function request(): TickRequestRecord {
  return {
    schemaVersion: 1,
    localId: "request-1",
    requester: `0x${"33".repeat(32)}`,
    status: "accepted",
    transactionHash: `0x${"44".repeat(32)}`,
    requestId: `0x${"55".repeat(32)}`,
    receiptBlock: "7",
    submittedAt: "2026-08-29T00:00:00.000Z",
    acceptedAt: "2026-08-29T00:00:01.000Z",
    observedThroughBlock: null,
    resultingGeneration: null,
    resultingPopulation: null,
    resultingStateDigest: null,
    advancedTransactionHash: null,
    diagnostic: null,
  };
}
