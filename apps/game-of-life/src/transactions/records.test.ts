import { describe, expect, test, vi } from "vitest";
import {
  crankStorageKey,
  loadCranks,
  loadRequests,
  requestStorageKey,
  saveCranks,
  saveRequests,
  transactionLockName,
  withTransactionLock,
  type CrankRecord,
  type TickRequestRecord,
  type TransactionScope,
} from "./records";

const scope: TransactionScope = {
  networkId: "11".repeat(32),
  expectedCaller: `0x${"22".repeat(32)}`,
  contractAddress: `0x${"33".repeat(32)}`,
};

describe("transaction records", () => {
  test("persists requests and cranks independently in the full scope", () => {
    saveRequests(scope, [request()]);
    saveCranks(scope, [crank()]);
    expect(loadRequests(scope)).toHaveLength(1);
    expect(loadCranks(scope)).toHaveLength(1);
    expect(requestStorageKey(scope)).not.toBe(crankStorageKey(scope));
    expect(transactionLockName(scope)).toContain(scope.contractAddress);
    expect(transactionLockName(scope)).toContain(scope.expectedCaller);
  });

  test("preserves malformed storage and fails closed", () => {
    localStorage.setItem(requestStorageKey(scope), "not-json");
    expect(() => loadRequests(scope)).toThrow(/invalid/);
    expect(localStorage.getItem(requestStorageKey(scope))).toBe("not-json");
  });

  test("rejects records that contradict their account scope or lifecycle", () => {
    expect(() =>
      saveRequests(scope, [
        { ...request(), requester: `0x${"99".repeat(32)}` },
      ]),
    ).toThrow(/invalid/);
    expect(() =>
      saveRequests(scope, [
        {
          ...request(),
          status: "advanced",
          resultingGeneration: null,
        },
      ]),
    ).toThrow(/invalid/);
  });

  test("uses an exclusive Web Lock", async () => {
    const action = vi.fn(async () => 7);
    await expect(withTransactionLock(scope, action)).resolves.toBe(7);
    expect(action).toHaveBeenCalledOnce();
  });
});

function request(): TickRequestRecord {
  return {
    schemaVersion: 1,
    localId: "request-1",
    requester: scope.expectedCaller,
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

function crank(): CrankRecord {
  return {
    schemaVersion: 1,
    localId: "crank-1",
    submittedBy: scope.expectedCaller,
    status: "noWork",
    transactionHash: `0x${"66".repeat(32)}`,
    submittedAt: "2026-08-29T00:00:02.000Z",
    completedAt: "2026-08-29T00:00:03.000Z",
    receiptBlock: "8",
    consumedRequestId: null,
    resultingGeneration: null,
    resultingPopulation: null,
    resultingStateDigest: null,
    diagnostic: "Crank found no work",
  };
}
