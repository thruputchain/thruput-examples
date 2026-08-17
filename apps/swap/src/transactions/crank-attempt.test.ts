import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import {
  crankAttemptKey,
  CrankAttemptError,
  createCrankAttempt,
  isBlockingCrankAttempt,
  loadCrankAttempt,
  saveCrankAttempt,
} from "./crank-attempt";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config = {
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  pairAddress: address(2),
  driverAddress: address(3),
} as AppConfig;

describe("crank attempt", () => {
  beforeEach(() => window.localStorage.clear());

  it("round trips signed and indeterminate recovery state", () => {
    const signing = saveCrankAttempt(config, createCrankAttempt(config, 10));
    expect(isBlockingCrankAttempt(signing)).toBe(true);

    const indeterminate = saveCrankAttempt(config, {
      ...signing,
      status: "indeterminate",
      transactionHash: `0x${"ab".repeat(32)}`,
      updatedAt: 11,
      message: "Outcome uncertain",
    });

    expect(loadCrankAttempt(config)).toEqual(indeterminate);
    expect(isBlockingCrankAttempt(indeterminate)).toBe(true);
  });

  it("allows authoritative terminal attempts without blocking a retry", () => {
    const failed = saveCrankAttempt(config, {
      ...createCrankAttempt(config, 10),
      status: "failed",
      updatedAt: 11,
      message: "Not submitted",
    });

    expect(loadCrankAttempt(config)).toEqual(failed);
    expect(isBlockingCrankAttempt(failed)).toBe(false);
  });

  it("rejects malformed or differently scoped storage", () => {
    window.localStorage.setItem(crankAttemptKey(config), "{}");
    expect(() => loadCrankAttempt(config)).toThrow(CrankAttemptError);

    saveCrankAttempt(config, createCrankAttempt(config, 10));
    const other = { ...config, driverAddress: address(4) };
    window.localStorage.setItem(
      crankAttemptKey(other),
      window.localStorage.getItem(crankAttemptKey(config))!,
    );
    expect(() => loadCrankAttempt(other)).toThrow(CrankAttemptError);
  });
});
