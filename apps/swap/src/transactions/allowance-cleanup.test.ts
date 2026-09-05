import type { TransactionReceipt } from "@groundhogchain/client";
import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { loadCleanupAllowanceRequirement } from "./account-allowance";
import {
  dismissTerminalRequest,
  saveRequestCollection,
  type RequestRecord,
} from "./request-collection";
import {
  allowanceCleanupKey,
  confirmAllowanceCleanupWasNotSigned,
  loadAllowanceCleanup,
  runAllowanceCleanup,
} from "./allowance-cleanup";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  liquidityTokenAddress: address(11),
  handlerAddress: address(12),
  driverAddress: address(13),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
} satisfies AppConfig;

describe("allowance cleanup", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists before signing and removes confirmed excess", async () => {
    const execute = vi.fn(async (_target, observer) => {
      expect(loadAllowanceCleanup(config)).toMatchObject({
        tokenAddress: hex(1),
        spenderAddress: hex(12),
        transactionHash: null,
        difference: "-100",
      });
      observer?.onSigned(hex(40));
      expect(loadAllowanceCleanup(config)?.transactionHash).toBe(hex(40));
      return {
        kind: "committedSuccess" as const,
        hash: hex(40),
        receipt: {} as TransactionReceipt,
      };
    });

    await expect(runAllowanceCleanup(config, address(1), address(12), {
      writeBoundary: { execute },
      readAllowance: async () => ({ value: 100n, height: 1n }),
      now: () => 10,
    })).resolves.toEqual({ kind: "committed", requiredAllowance: 0n });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(loadAllowanceCleanup(config)).toBeNull();
  });

  it("recovers an indeterminate cleanup from its original hash", async () => {
    const execute = vi.fn(async (_target, observer) => {
      observer?.onSigned(hex(40));
      return { kind: "indeterminate" as const, hash: hex(40), reason: "timeout" as const };
    });
    const observe = vi.fn().mockResolvedValue({
      kind: "committedSuccess",
      hash: hex(40),
      receipt: {} as TransactionReceipt,
    });
    const dependencies = {
      writeBoundary: { execute, observe },
      readAllowance: async () => ({ value: 100n, height: 1n }),
    };

    expect((await runAllowanceCleanup(
      config,
      address(1),
      address(12),
      dependencies,
    )).kind).toBe("pending");
    await expect(runAllowanceCleanup(
      config,
      address(1),
      address(12),
      dependencies,
    )).resolves.toEqual({ kind: "committed", requiredAllowance: 0n });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(hex(40));
    expect(loadAllowanceCleanup(config)).toBeNull();
  });

  it("requires confirmation after an interruption before hash persistence", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("page closed"));
    const dependencies = {
      writeBoundary: { execute },
      readAllowance: async () => ({ value: 100n, height: 1n }),
    };

    await expect(runAllowanceCleanup(
      config,
      address(1),
      address(12),
      dependencies,
    )).rejects.toThrow("page closed");
    expect(loadAllowanceCleanup(config)?.transactionHash).toBeNull();
    await expect(runAllowanceCleanup(
      config,
      address(1),
      address(12),
      dependencies,
    )).rejects.toThrow("Confirm that the pre-hash allowance cleanup was never signed");

    await confirmAllowanceCleanupWasNotSigned(config);
    expect(window.localStorage.getItem(allowanceCleanupKey(config))).toBeNull();
  });

  it("refuses an allowance view older than terminal evidence", async () => {
    saveRequestCollection(config, [terminalRequest()]);

    await expect(runAllowanceCleanup(config, address(1), address(12), {
      writeBoundary: { execute: vi.fn() },
      readAllowance: async () => ({ value: 100n, height: 11n }),
    })).rejects.toThrow("older than the terminal operation evidence");
    expect(loadAllowanceCleanup(config)).toBeNull();
  });

  it("retains terminal evidence after history is dismissed", () => {
    const terminal = terminalRequest();
    saveRequestCollection(config, [terminal]);
    saveRequestCollection(
      config,
      dismissTerminalRequest([terminal], terminal.localId),
    );

    expect(loadCleanupAllowanceRequirement(config, hex(1), hex(12)))
      .toEqual({ requiredAllowance: 0n, minimumReadHeight: 12n });
  });
});

function terminalRequest(): RequestRecord {
  return {
    localId: "terminal",
    status: "executed",
    phase: "swap",
    intent: { amountIn: 10n, amountOutMin: 1n },
    transactionHash: hex(30),
    receiptBlock: 8n,
    requestId: hex(31),
    visibleObservationMs: 0,
    observationBaseline: null,
    criteria: {
      sender: hex(9),
      handlerAddress: hex(12),
      driverAddress: hex(13),
      recipient: hex(9),
      tokenIn: hex(1),
      tokenOut: hex(2),
    },
    createdAt: 1,
    updatedAt: 2,
    observedThroughBlock: 12n,
    snapshotInferenceEligible: false,
    execution: {
      kind: "executed",
      transactionHash: hex(40),
      blockHeight: 12n,
      amountIn: 10n,
      amountOut: 9n,
    },
  };
}
