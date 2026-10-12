import { toHex0x, type CoreGroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import type { GlobalConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { allowanceDifference } from "@/domain/allowance";
import { verifyReadNetwork } from "@/thruput/client";
import {
  loadCleanupAllowanceRequirement,
} from "@/transactions/account-allowance";
import {
  hasBlockingCreationTransaction,
  loadAccountCreationWorkflows,
} from "@/transactions/creation-workflow";
import {
  isBlockingCrankAttempt,
  loadAccountCrankAttempts,
} from "@/transactions/crank-attempt";
import {
  hasBlockingLiquidityTransaction,
  loadAccountLiquidityOperations,
} from "@/transactions/liquidity-operation";
import { withAccountLock } from "@/transactions/account-lock";
import { loadAccountRequestRecords } from "@/transactions/request-collection";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

const STORAGE_VERSION = 2;
const ADDRESS_PATTERN = /^0x[0-9a-f]{64}$/;

export interface AllowanceCleanupRecord {
  version: typeof STORAGE_VERSION;
  networkIdHex: string;
  accountAddress: string;
  tokenAddress: string;
  spenderAddress: string;
  status: "signing" | "indeterminate";
  transactionHash: string | null;
  difference: string;
  updatedAt: number;
}

export type AllowanceCleanupResult =
  | { kind: "notNeeded"; requiredAllowance: bigint }
  | { kind: "committed"; requiredAllowance: bigint }
  | { kind: "pending"; record: AllowanceCleanupRecord }
  | { kind: "failed"; message: string };

class AllowanceCleanupRecoveryError extends Error {
  constructor() {
    super("Confirm that the pre-hash allowance cleanup was never signed before retrying");
    this.name = "AllowanceCleanupRecoveryError";
  }
}

export interface AllowanceCleanupDependencies {
  client: Pick<CoreGroundhogClient, "getNetworkInfo">;
  writeBoundary: WriteBoundary;
  readAllowance: (
    token: ContractAddress,
    handler: ContractAddress,
  ) => Promise<{ value: bigint; height: bigint }>;
  now?: () => number;
  assertCurrent?: () => void;
}

type AllowanceCleanupScope = Pick<GlobalConfig, "networkIdHex" | "accountAddress">;

export function allowanceCleanupKey(config: AllowanceCleanupScope): string {
  return [
    "groundhog-swap:allowance-cleanup:v2",
    config.networkIdHex,
    toHex0x(config.accountAddress),
  ].join(":");
}

export function loadAllowanceCleanup(
  config: AllowanceCleanupScope,
): AllowanceCleanupRecord | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(allowanceCleanupKey(config));
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isCleanupRecord(parsed, config)) throw new Error("invalid cleanup");
    return parsed;
  } catch {
    throw new Error("Stored allowance cleanup progress is invalid");
  }
}

export function hasBlockingAllowanceCleanup(config: AllowanceCleanupScope): boolean {
  return loadAllowanceCleanup(config) !== null;
}

export async function confirmAllowanceCleanupWasNotSigned(
  config: AllowanceCleanupScope,
): Promise<void> {
  await withAccountLock(config, async () => {
    const record = loadAllowanceCleanup(config);
    if (record === null || record.transactionHash !== null) {
      throw new Error("The allowance cleanup has a transaction hash and must be observed");
    }
    window.localStorage.removeItem(allowanceCleanupKey(config));
  });
}

export async function runAllowanceCleanup(
  config: GlobalConfig,
  token: ContractAddress,
  spender: ContractAddress,
  dependencies: AllowanceCleanupDependencies,
): Promise<AllowanceCleanupResult> {
  return withAccountLock(config, async () => {
    dependencies.assertCurrent?.();
    const client = dependencies.client;
    await verifyReadNetwork(client, config);
    const tokenAddress = toHex0x(token);
    const spenderAddress = toHex0x(spender);
    const existing = loadAllowanceCleanup(config);
    if (
      existing !== null
      && (existing.tokenAddress !== tokenAddress
        || existing.spenderAddress !== spenderAddress)
    ) {
      throw new Error("Resolve the account's pending allowance cleanup first");
    }
    if (existing !== null) {
      if (existing.transactionHash === null) {
        throw new AllowanceCleanupRecoveryError();
      }
      if (dependencies.writeBoundary.observe === undefined) {
        throw new Error("This wallet cannot recover the stored allowance cleanup");
      }
      const observed = await dependencies.writeBoundary.observe(
        existing.transactionHash,
      );
      await verifyReadNetwork(client, config);
      return applyWriteResult(config, existing, observed);
    }

    assertAccountCanClean(config);
    const requirement = loadCleanupAllowanceRequirement(
      config,
      tokenAddress,
      spenderAddress,
    );
    const current = await dependencies.readAllowance(token, spender);
    await verifyReadNetwork(client, config);
    dependencies.assertCurrent?.();
    if (current.height < requirement.minimumReadHeight) {
      throw new Error("The allowance view is older than the terminal operation evidence");
    }
    if (current.value <= requirement.requiredAllowance) {
      return {
        kind: "notNeeded",
        requiredAllowance: requirement.requiredAllowance,
      };
    }
    const difference = allowanceDifference(
      requirement.requiredAllowance,
      current.value,
    );
    if (!difference.ok) throw new Error("The allowance cleanup exceeds the signed contract range");
    const now = dependencies.now ?? Date.now;
    let record: AllowanceCleanupRecord = {
      version: STORAGE_VERSION,
      networkIdHex: config.networkIdHex,
      accountAddress: toHex0x(config.accountAddress),
      tokenAddress,
      spenderAddress,
      status: "signing",
      transactionHash: null,
      difference: difference.difference.toString(),
      updatedAt: now(),
    };
    saveAllowanceCleanup(config, record);
    const result = await dependencies.writeBoundary.execute(
      buildApprovalTarget(token, spender, difference.difference),
      {
        onSigned: (transactionHash) => {
          record = { ...record, transactionHash, updatedAt: now() };
          saveAllowanceCleanup(config, record);
        },
      },
    );
    await verifyReadNetwork(client, config);
    return applyWriteResult(
      config,
      record,
      result,
      requirement.requiredAllowance,
      now,
    );
  });
}

function applyWriteResult(
  config: GlobalConfig,
  record: AllowanceCleanupRecord,
  result: WriteResult,
  requiredAllowance = loadCleanupAllowanceRequirement(
    config,
    record.tokenAddress,
    record.spenderAddress,
  ).requiredAllowance,
  now: () => number = Date.now,
): AllowanceCleanupResult {
  if (result.kind === "committedSuccess") {
    window.localStorage.removeItem(allowanceCleanupKey(config));
    return { kind: "committed", requiredAllowance };
  }
  if (result.kind === "indeterminate") {
    const pending: AllowanceCleanupRecord = {
      ...record,
      status: "indeterminate",
      transactionHash: result.hash ?? record.transactionHash,
      updatedAt: now(),
    };
    saveAllowanceCleanup(config, pending);
    return { kind: "pending", record: pending };
  }
  window.localStorage.removeItem(allowanceCleanupKey(config));
  return { kind: "failed", message: cleanupFailureMessage(result) };
}

function assertAccountCanClean(config: GlobalConfig): void {
  if (loadAccountCrankAttempts(config).some(isBlockingCrankAttempt)) {
    throw new Error("Resolve the account's pending queue-processing transaction first");
  }
  if (loadAccountCreationWorkflows(config).some(hasBlockingCreationTransaction)) {
    throw new Error("Resolve the account's pending pool-creation transaction first");
  }
  if (loadAccountLiquidityOperations(config).some(hasBlockingLiquidityTransaction)) {
    throw new Error("Resolve the account's pending liquidity transaction first");
  }
  if (loadAccountRequestRecords(config).some((request) =>
    request.status === "approving"
    || request.status === "submitting"
    || request.status === "indeterminate"
  )) {
    throw new Error("Resolve the account's pending swap transaction first");
  }
}

function saveAllowanceCleanup(
  config: AllowanceCleanupScope,
  record: AllowanceCleanupRecord,
): void {
  if (!isCleanupRecord(record, config)) {
    throw new Error("Allowance cleanup progress is invalid");
  }
  window.localStorage.setItem(allowanceCleanupKey(config), JSON.stringify(record));
}

function isCleanupRecord(
  value: unknown,
  config: AllowanceCleanupScope,
): value is AllowanceCleanupRecord {
  if (!isRecord(value)) return false;
  return value.version === STORAGE_VERSION
    && value.networkIdHex === config.networkIdHex
    && value.accountAddress === toHex0x(config.accountAddress)
    && typeof value.tokenAddress === "string"
    && ADDRESS_PATTERN.test(value.tokenAddress)
    && typeof value.spenderAddress === "string"
    && ADDRESS_PATTERN.test(value.spenderAddress)
    && (value.status === "signing" || value.status === "indeterminate")
    && (value.transactionHash === null
      || (typeof value.transactionHash === "string"
        && ADDRESS_PATTERN.test(value.transactionHash)))
    && typeof value.difference === "string"
    && /^-\d+$/.test(value.difference)
    && BigInt(value.difference) < 0n
    && typeof value.updatedAt === "number"
    && Number.isSafeInteger(value.updatedAt)
    && value.updatedAt >= 0;
}

function cleanupFailureMessage(
  result: Exclude<WriteResult, { kind: "committedSuccess" | "indeterminate" }>,
): string {
  if (result.kind === "preSubmissionFailure") return result.message;
  if (result.kind === "invalid") return result.reason;
  return "The allowance cleanup transaction committed without succeeding";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
