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
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
  liquidityTokenAddress: address(5),
  handlerAddress: address(6),
  driverAddress: address(7),
  tokenAAddress: address(8),
  tokenBAddress: address(9),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
} satisfies AppConfig;

describe("crank attempt", () => {
  beforeEach(() => window.localStorage.clear());

  it("round trips recovery state in the v3 namespace", () => {
    const signing = saveCrankAttempt(config, createCrankAttempt(config, 10));
    const indeterminate = saveCrankAttempt(config, {
      ...signing,
      status: "indeterminate",
      transactionHash: `0x${"ab".repeat(32)}`,
      updatedAt: 11,
      message: "Outcome uncertain",
    });

    expect(crankAttemptKey(config)).toContain("groundhog-swap:crank:v3");
    expect(loadCrankAttempt(config)).toEqual(indeterminate);
    expect(isBlockingCrankAttempt(indeterminate)).toBe(true);
  });

  it("loads attempts across current pool scopes", () => {
    const other = { ...config, factoryAddress: address(10), driverAddress: address(11) };
    saveCrankAttempt(config, createCrankAttempt(config, 10));
    saveCrankAttempt(other, createCrankAttempt(other, 11));
    expect(loadAccountCrankAttempts(config)).toHaveLength(2);
  });

  it("ignores retired namespaces without deleting them", () => {
    const legacy = `groundhog-swap:crank:v2:${config.networkIdHex}:old`;
    window.localStorage.setItem(legacy, "not-json");
    expect(loadAccountCrankAttempts(config)).toEqual([]);
    expect(window.localStorage.getItem(legacy)).toBe("not-json");
  });

  it("rejects malformed current storage", () => {
    window.localStorage.setItem(crankAttemptKey(config), "{}");
    expect(() => loadCrankAttempt(config)).toThrow(CrankAttemptError);
  });
});
