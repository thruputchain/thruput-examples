import { toBase58 } from "@thruputchain/client";
import type { TransactionReceipt } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
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
const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const client = { getNetworkInfo: vi.fn() };
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
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
  beforeEach(() => {
    window.localStorage.clear();
    client.getNetworkInfo.mockReset().mockResolvedValue({ networkHash: new Uint8Array(32) });
  });

  it("persists before signing and removes confirmed excess", async () => {
    const execute = vi.fn(async (_target, observer) => {
      expect(loadAllowanceCleanup(config)).toMatchObject({
        tokenAddress: id(1),
        spenderAddress: id(12),
        transactionHash: null,
        difference: "-100",
      });
      observer?.onSigned(id(40));
      expect(loadAllowanceCleanup(config)?.transactionHash).toBe(id(40));
      return {
        kind: "committedSuccess" as const,
        hash: id(40),
        receipt: {} as TransactionReceipt,
      };
    });

    await expect(runAllowanceCleanup(config, address(1), address(12), {
      client,
      writeBoundary: { execute },
      readAllowance: async () => ({ value: 100n, height: 1n }),
      now: () => 10,
    })).resolves.toEqual({ kind: "committed", requiredAllowance: 0n });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(loadAllowanceCleanup(config)).toBeNull();
  });

  it("recovers an indeterminate cleanup from its original hash", async () => {
    const execute = vi.fn(async (_target, observer) => {
      observer?.onSigned(id(40));
      return { kind: "indeterminate" as const, hash: id(40), reason: "timeout" as const };
    });
    const observe = vi.fn().mockResolvedValue({
      kind: "committedSuccess",
      hash: id(40),
      receipt: {} as TransactionReceipt,
    });
    const dependencies = {
      client,
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
    expect(observe).toHaveBeenCalledWith(id(40));
    expect(loadAllowanceCleanup(config)).toBeNull();
  });

  it("requires confirmation after an interruption before hash persistence", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("page closed"));
    const dependencies = {
      client,
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
      client,
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

    expect(loadCleanupAllowanceRequirement(config, id(1), id(12)))
      .toEqual({ requiredAllowance: 0n, minimumReadHeight: 12n });
  });

  it.each([false, true])("preserves cleanup evidence on network mismatch (recovery: %s)", async (recovery) => {
    const record = {
      version: 3, networkId: config.networkId, accountAddress: id(9),
      tokenAddress: id(6), spenderAddress: id(7), status: "indeterminate",
      transactionHash: id(40), difference: "-300", updatedAt: 10,
    };
    if (recovery) window.localStorage.setItem(allowanceCleanupKey(config), JSON.stringify(record));
    client.getNetworkInfo.mockResolvedValue({ networkHash: new Uint8Array(32).fill(1) });
    const execute = vi.fn();
    const observe = vi.fn();
    const readAllowance = vi.fn(async () => ({ value: 0n, height: 12n }));
    await expect(runAllowanceCleanup(config, address(6), address(7), {
      client,
      writeBoundary: { execute, observe }, readAllowance,
    })).rejects.toThrow("different Thruput network");
    expect(execute).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(readAllowance).not.toHaveBeenCalled();
    expect(loadAllowanceCleanup(config)).toEqual(recovery ? record : null);
  });

  it("does not accept a zero allowance when the network changes during the read", async () => {
    client.getNetworkInfo.mockResolvedValueOnce({ networkHash: new Uint8Array(32) })
      .mockResolvedValue({ networkHash: new Uint8Array(32).fill(1) });
    const execute = vi.fn();
    await expect(runAllowanceCleanup(config, address(6), address(7), {
      client,
      writeBoundary: { execute },
      readAllowance: async () => ({ value: 0n, height: 12n }),
    })).rejects.toThrow("different Thruput network");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves a signed cleanup hash if the network changes while observing it", async () => {
    const record = {
      version: 3, networkId: config.networkId, accountAddress: id(9),
      tokenAddress: id(6), spenderAddress: id(7), status: "signing",
      transactionHash: id(40), difference: "-300", updatedAt: 10,
    };
    window.localStorage.setItem(allowanceCleanupKey(config), JSON.stringify(record));
    client.getNetworkInfo.mockResolvedValueOnce({ networkHash: new Uint8Array(32) })
      .mockResolvedValue({ networkHash: new Uint8Array(32).fill(1) });
    const execute = vi.fn();
    const observe = vi.fn().mockResolvedValue({ kind: "committedSuccess", hash: id(40), receipt: {} });
    await expect(runAllowanceCleanup(config, address(6), address(7), {
      client,
      writeBoundary: { execute, observe }, readAllowance: vi.fn(),
    })).rejects.toThrow("different Thruput network");
    expect(loadAllowanceCleanup(config)).toEqual(record);
    expect(execute).not.toHaveBeenCalled();
  });
});

function terminalRequest(): RequestRecord {
  return {
    localId: "terminal",
    status: "executed",
    phase: "swap",
    intent: { amountIn: 10n, amountOutMin: 1n },
    transactionHash: id(30),
    receiptBlock: 8n,
    requestId: hex(31),
    visibleObservationMs: 0,
    observationBaseline: null,
    criteria: {
      sender: id(9),
      handlerAddress: id(12),
      driverAddress: id(13),
      recipient: id(9),
      tokenIn: id(1),
      tokenOut: id(2),
    },
    createdAt: 1,
    updatedAt: 2,
    observedThroughBlock: 12n,
    snapshotInferenceEligible: false,
    execution: {
      kind: "executed",
      transactionHash: id(40),
      blockHeight: 12n,
      amountIn: 10n,
      amountOut: 9n,
    },
  };
}
