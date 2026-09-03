import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import {
  clearOutstandingRequest,
  loadOutstandingRequest,
  saveOutstandingRequest,
} from "./outstanding-request";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config = {
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  handlerAddress: address(3),
  driverAddress: address(6),
  tokenAAddress: address(4),
  tokenBAddress: address(5),
} as AppConfig;
const criteria = {
  handlerAddress: `0x${"03".repeat(32)}`,
  driverAddress: `0x${"06".repeat(32)}`,
  sender: `0x${"01".repeat(32)}`,
  recipient: `0x${"01".repeat(32)}`,
  tokenIn: `0x${"04".repeat(32)}`,
  tokenOut: `0x${"05".repeat(32)}`,
};

describe("outstanding request storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round trips bigint request details without credentials", () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10n, amountOutMin: 9n },
      transactionHash: `0x${"ab".repeat(32)}`,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 500,
      observationBaseline: {
        chainHeight: 11n,
        inputBalance: 20n,
        outputBalance: 30n,
        inputAllowance: 10n,
        reserveIn: 100n,
        reserveOut: 200n,
      },
      criteria,
    });

    expect(loadOutstandingRequest(config)).toEqual({
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10n, amountOutMin: 9n },
      transactionHash: `0x${"ab".repeat(32)}`,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 500,
      observationBaseline: {
        chainHeight: 11n,
        inputBalance: 20n,
        outputBalance: 30n,
        inputAllowance: 10n,
        reserveIn: 100n,
        reserveOut: 200n,
      },
      criteria,
    });
  });

  it("discards malformed storage and clears explicitly", () => {
    window.localStorage.setItem(
      `groundhog-swap:outstanding:v1:${"00".repeat(32)}:0x${"01".repeat(32)}:0x${"02".repeat(32)}`,
      "not json",
    );
    expect(loadOutstandingRequest(config)).toBeNull();

    saveOutstandingRequest(config, {
      status: "submitting",
      phase: "swap",
      intent: { amountIn: 1n, amountOutMin: 1n },
      transactionHash: null,
      receiptBlock: null,
      requestId: null,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    clearOutstandingRequest(config);
    expect(loadOutstandingRequest(config)).toBeNull();
  });

  it("ignores the retired v1 namespace", () => {
    const key = `groundhog-swap:outstanding:v1:${"00".repeat(32)}:old`;
    window.localStorage.setItem(key, "not-json");
    expect(loadOutstandingRequest(config)).toBeNull();
    expect(window.localStorage.getItem(key)).toBe("not-json");
  });

  it("discards records whose criteria do not match the active configuration", () => {
    saveOutstandingRequest(config, {
      status: "submitting",
      phase: "swap",
      intent: { amountIn: 1n, amountOutMin: 1n },
      transactionHash: hash(0xab),
      receiptBlock: null,
      requestId: null,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria: { ...criteria, tokenOut: hash(0xff) },
    });

    expect(loadOutstandingRequest(config)).toBeNull();
  });

  it("requires the durable fields implied by each terminal status", () => {
    const key = `groundhog-swap:outstanding:v1:${"00".repeat(32)}:0x${"01".repeat(32)}:0x${"02".repeat(32)}`;
    window.localStorage.setItem(
      key,
      JSON.stringify({
        status: "queuedNotObserved",
        phase: "swap",
        amountIn: "10",
        amountOutMin: "9",
        transactionHash: hash(0xab),
        receiptBlock: "12",
        requestId: null,
        criteria,
      }),
    );

    expect(loadOutstandingRequest(config)).toBeNull();
  });
});

function hash(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}
