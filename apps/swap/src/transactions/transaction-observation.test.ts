import {
  hashFromHex,
  TransactionProcessingError,
  type GroundhogClient,
  type SchedulerTransactionError,
} from "@groundhogchain/client";
import { TransactionObservationError } from "@groundhogchain/client/wallet";
import { describe, expect, it, vi } from "vitest";
import {
  createTransactionObserver,
  executionFailure,
  observationFailure,
} from "./transaction-observation";

const hash = `0x${"ab".repeat(32)}`;
const txHash = hashFromHex(hash);
const error: SchedulerTransactionError = { source: "executor", code: 3 };

describe.each(["retry", "dropped"] as const)(
  "a %s scheduler outcome",
  (status) => {
    const processing = () => new TransactionProcessingError(txHash, status, error);
    const expected = {
      kind: "invalid",
      hash,
      reason: expect.stringContaining("executor error 3"),
    };

    it("is a resubmittable invalid result that keeps the hash", () => {
      expect(observationFailure(hash, processing())).toEqual(expected);
    });

    it("keeps the hash when the wallet wraps it in an observation error", () => {
      expect(
        executionFailure(new TransactionObservationError(txHash, processing())),
      ).toEqual(expected);
    });

    it("is reported by the public observer", async () => {
      const client = {
        waitForTransactionReceipt: vi.fn().mockRejectedValue(processing()),
      };
      const observe = createTransactionObserver(
        { networkIdHex: "00".repeat(32) },
        client as unknown as GroundhogClient,
      );
      expect(await observe(hash)).toEqual(expected);
    });

    it("says whether the transaction may be submitted again", () => {
      const result = observationFailure(hash, processing());
      expect(result.kind === "invalid" && result.reason).toMatch(
        status === "retry" ? /may be submitted again/ : /dropped/,
      );
    });
  },
);
