import { describe, it, expect } from "vitest";
import {
  MAX_APPROVALS,
  MAX_APPROVAL_BYTES,
  MAX_OUTGOING,
  replaceApproval,
  assertTransferAvailable,
  type OutgoingTransfer,
} from "./lifecycle";
import type { SignedApproval } from "./policy";
const approval = (
  origin: string,
  signedTransaction = "0xaa",
): SignedApproval => ({
  origin,
  account: "account",
  networkHash: "network",
  signedTransaction,
  hash: "hash",
});
describe("bounded approval and recovery storage", () => {
  it("retains only the latest tuple approval without mutating committed state", () => {
    const original = [approval("https://a.example")];
    const next = replaceApproval(
      original,
      approval("https://a.example", "0xbb"),
    );
    expect(original[0]!.signedTransaction).toBe("0xaa");
    expect(next).toHaveLength(1);
    expect(next[0]!.signedTransaction).toBe("0xbb");
  });
  it("rejects count and UTF-8 byte overflow without evicting earlier authorizations", () => {
    const original = Array.from({ length: MAX_APPROVALS }, (_, i) =>
      approval(`https://${i}.example`),
    );
    expect(() =>
      replaceApproval(original, approval("https://extra.example")),
    ).toThrow("capacity");
    expect(original).toHaveLength(MAX_APPROVALS);
    expect(() =>
      replaceApproval(
        [],
        approval("https://a.example", "a".repeat(MAX_APPROVAL_BYTES)),
      ),
    ).toThrow("capacity");
  });
  it("never evicts unresolved recovery records and requires acknowledgment when full", () => {
    const record: OutgoingTransfer = {
      account: "a",
      network: "localnet",
      networkHash: "n",
      hash: "h",
      outcome: "unknown",
      createdAt: 0,
    };
    expect(() => assertTransferAvailable([record], "a", "n")).toThrow(
      "unresolved",
    );
    expect(() =>
      assertTransferAvailable([{ ...record, outcome: "confirmed" }], "a", "n"),
    ).not.toThrow();
    expect(() =>
      assertTransferAvailable(
        Array.from({ length: MAX_OUTGOING }, () => record),
        "other",
        "n",
      ),
    ).toThrow("Acknowledge");
  });
});
