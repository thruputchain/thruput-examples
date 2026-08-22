import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import {
  crankAttemptKey,
  CrankAttemptError,
  createCrankAttempt,
  isBlockingCrankAttempt,
  loadAccountCrankAttempts,
  loadCrankAttempt,
  saveCrankAttempt,
} from "./crank-attempt";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config = {
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  factoryAddress: address(7),
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

  it("aggregates driver-scoped attempts across factories", () => {
    const other = {
      ...config,
      factoryAddress: address(8),
      pairAddress: address(9),
      driverAddress: address(10),
    };
    saveCrankAttempt(config, createCrankAttempt(config, 10));
    saveCrankAttempt(other, createCrankAttempt(other, 11));

    expect(loadAccountCrankAttempts(config)).toHaveLength(2);
  });

  it("migrates the pair-scoped v1 attempt", () => {
    const attempt = saveCrankAttempt(config, createCrankAttempt(config, 10));
    const stored = window.localStorage.getItem(crankAttemptKey(config))!;
    window.localStorage.clear();
    const legacyKey = [
      "groundhog-swap:crank:v1",
      config.networkIdHex,
      `0x${"01".repeat(32)}`,
      `0x${"02".repeat(32)}`,
    ].join(":");
    window.localStorage.setItem(legacyKey, stored);

    expect(loadCrankAttempt(config)).toEqual(attempt);
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
    expect(window.localStorage.getItem(crankAttemptKey(config))).not.toBeNull();
  });

  it("includes legacy attempts from other pools in account safety checks", () => {
    const other = {
      ...config,
      pairAddress: address(9),
      driverAddress: address(10),
    };
    const attempt = saveCrankAttempt(other, createCrankAttempt(other, 10));
    const stored = window.localStorage.getItem(crankAttemptKey(other))!;
    window.localStorage.clear();
    const legacyKey = [
      "groundhog-swap:crank:v1",
      config.networkIdHex,
      `0x${"01".repeat(32)}`,
      `0x${"09".repeat(32)}`,
    ].join(":");
    window.localStorage.setItem(legacyKey, stored);

    expect(loadAccountCrankAttempts(config)).toEqual([attempt]);
  });

  it("promotes a late blocking v1 attempt over terminal v2 state", () => {
    const terminal = saveCrankAttempt(config, {
      ...createCrankAttempt(config, 10),
      status: "failed",
      updatedAt: 11,
      message: "Not submitted",
    });
    const terminalStored = window.localStorage.getItem(crankAttemptKey(config))!;
    const blocking = saveCrankAttempt(config, createCrankAttempt(config, 12));
    const blockingStored = window.localStorage.getItem(crankAttemptKey(config))!;
    const legacyKey = [
      "groundhog-swap:crank:v1",
      config.networkIdHex,
      `0x${"01".repeat(32)}`,
      `0x${"02".repeat(32)}`,
    ].join(":");
    window.localStorage.setItem(crankAttemptKey(config), terminalStored);
    window.localStorage.setItem(legacyKey, blockingStored);

    expect(loadCrankAttempt(config)).toEqual(blocking);
    expect(loadCrankAttempt(config)).not.toEqual(terminal);
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });

  it("keeps authoritative fields from a late same-attempt v1 update", () => {
    const signing = saveCrankAttempt(config, createCrankAttempt(config, 10));
    const currentStored = window.localStorage.getItem(crankAttemptKey(config))!;
    const signed = saveCrankAttempt(config, {
      ...signing,
      transactionHash: `0x${"ab".repeat(32)}`,
      updatedAt: 11,
    });
    const signedStored = window.localStorage.getItem(crankAttemptKey(config))!;
    const legacyKey = [
      "groundhog-swap:crank:v1",
      config.networkIdHex,
      `0x${"01".repeat(32)}`,
      `0x${"02".repeat(32)}`,
    ].join(":");
    window.localStorage.setItem(crankAttemptKey(config), currentStored);
    window.localStorage.setItem(legacyKey, signedStored);

    expect(loadCrankAttempt(config)).toEqual(signed);
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });
});
