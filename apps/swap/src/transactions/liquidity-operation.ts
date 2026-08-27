import { toHex0x } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import { recordAllowanceTerminalEvidence } from "@/transactions/allowance-evidence";

const STORAGE_VERSION = 1;
const TERMINAL_LIMIT = 50;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export type LiquidityOperationKind = "add" | "remove";
export type LiquidityOperationStatus = "active" | "queued" | "executed" | "failed";
export type LiquidityStepName = "approveToken0" | "approveToken1" | "approveLiquidity" | "enqueue";
export type LiquidityStepStatus =
  | "pending"
  | "signing"
  | "committed"
  | "skipped"
  | "failed"
  | "indeterminate";

export interface LiquidityStep {
  status: LiquidityStepStatus;
  transactionHash: string | null;
  message: string | null;
  updatedAt: number;
}

interface LiquidityOperationBase {
  version: typeof STORAGE_VERSION;
  id: string;
  kind: LiquidityOperationKind;
  status: LiquidityOperationStatus;
  networkIdHex: string;
  accountAddress: string;
  factoryAddress: string;
  pairAddress: string;
  handlerAddress: string;
  driverAddress: string;
  liquidityTokenAddress: string;
  token0Address: string;
  token1Address: string;
  recipient: string;
  requestId: string | null;
  receiptBlock: string | null;
  terminalBlock?: string | null;
  observedThroughBlock: string | null;
  steps: Record<LiquidityStepName, LiquidityStep>;
  createdAt: number;
  updatedAt: number;
}

export interface AddLiquidityOperation extends LiquidityOperationBase {
  kind: "add";
  intent: {
    amountsDesired: readonly [string, string];
    amountsMin: readonly [string, string];
    estimatedLiquidity: string;
    liquidityBalanceBefore: string;
    reservesBefore: readonly [string, string];
  };
  result: null | {
    transactionHash: string;
    blockHeight: string;
    liquidityMinted: string;
    amountsDeposited: readonly [string, string] | null;
    recipientVerified: boolean;
  };
}

export interface RemoveLiquidityOperation extends LiquidityOperationBase {
  kind: "remove";
  intent: {
    liquidity: string;
    amountsMin: readonly [string, string];
  };
  result: null | {
    transactionHash: string;
    blockHeight: string;
    amountsRedeemed: readonly [string, string];
  };
}

export type LiquidityOperation = AddLiquidityOperation | RemoveLiquidityOperation;

interface StoredLiquidityCollection {
  version: typeof STORAGE_VERSION;
  operations: LiquidityOperation[];
}

export class LiquidityOperationError extends Error {
  constructor() {
    super("Stored liquidity operation history is invalid");
    this.name = "LiquidityOperationError";
  }
}

export function liquidityOperationKey(config: AppConfig): string {
  return [
    "groundhog-swap:liquidity:v1",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    toHex0x(config.factoryAddress),
    toHex0x(config.pairAddress),
  ].join(":");
}

export function isAccountLiquidityOperationKey(
  config: Pick<AppConfig, "networkIdHex" | "accountAddress">,
  key: string | null,
): boolean {
  return key?.startsWith([
    "groundhog-swap:liquidity:v1",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    "",
  ].join(":")) ?? false;
}

export function createAddLiquidityOperation(
  config: AppConfig,
  intent: {
    amountsDesired: readonly [bigint, bigint];
    amountsMin: readonly [bigint, bigint];
    estimatedLiquidity: bigint;
    liquidityBalanceBefore: bigint;
    reservesBefore: readonly [bigint, bigint];
  },
  now = Date.now(),
): AddLiquidityOperation {
  return {
    ...baseOperation(config, "add", now),
    kind: "add",
    intent: {
      amountsDesired: stringifyPair(intent.amountsDesired),
      amountsMin: stringifyPair(intent.amountsMin),
      estimatedLiquidity: intent.estimatedLiquidity.toString(),
      liquidityBalanceBefore: intent.liquidityBalanceBefore.toString(),
      reservesBefore: stringifyPair(intent.reservesBefore),
    },
    result: null,
  };
}

export function createRemoveLiquidityOperation(
  config: AppConfig,
  intent: { liquidity: bigint; amountsMin: readonly [bigint, bigint] },
  now = Date.now(),
): RemoveLiquidityOperation {
  return {
    ...baseOperation(config, "remove", now),
    kind: "remove",
    intent: {
      liquidity: intent.liquidity.toString(),
      amountsMin: stringifyPair(intent.amountsMin),
    },
    result: null,
  };
}

export function loadLiquidityOperations(config: AppConfig): LiquidityOperation[] {
  if (typeof window === "undefined") return [];
  const stored = window.localStorage.getItem(liquidityOperationKey(config));
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isCollection(parsed, config, "pool")) throw new Error("invalid collection");
    return parsed.operations;
  } catch {
    throw new LiquidityOperationError();
  }
}

export function loadAccountLiquidityOperations(
  config: Pick<AppConfig, "networkIdHex" | "accountAddress">,
): LiquidityOperation[] {
  if (typeof window === "undefined") return [];
  const operations: LiquidityOperation[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !isAccountLiquidityOperationKey(config, key)) continue;
    const stored = window.localStorage.getItem(key);
    if (stored === null) continue;
    try {
      const parsed: unknown = JSON.parse(stored);
      if (!isCollection(parsed, config, "account")) throw new Error("invalid collection");
      if (parsed.operations.some((operation) => operationStorageKey(operation) !== key)) {
        throw new Error("operation scope mismatch");
      }
      operations.push(...parsed.operations);
    } catch {
      throw new LiquidityOperationError();
    }
  }
  return operations;
}

export function saveLiquidityOperations(
  config: AppConfig,
  operations: readonly LiquidityOperation[],
): LiquidityOperation[] {
  recordLiquidityAllowanceEvidence(config, [
    ...loadLiquidityOperations(config),
    ...operations,
  ]);
  const pruned = pruneOperations(operations);
  const stored: StoredLiquidityCollection = {
    version: STORAGE_VERSION,
    operations: [...pruned],
  };
  if (!isCollection(stored, config, "pool")) throw new LiquidityOperationError();
  window.localStorage.setItem(liquidityOperationKey(config), JSON.stringify(stored));
  return stored.operations;
}

function recordLiquidityAllowanceEvidence(
  config: AppConfig,
  operations: readonly LiquidityOperation[],
): void {
  for (const operation of operations) {
    if (operation.terminalBlock === undefined || operation.terminalBlock === null) {
      continue;
    }
    const block = BigInt(operation.terminalBlock);
    if (operation.kind === "add") {
      recordAllowanceTerminalEvidence(
        config,
        operation.token0Address,
        operation.handlerAddress,
        block,
      );
      recordAllowanceTerminalEvidence(
        config,
        operation.token1Address,
        operation.handlerAddress,
        block,
      );
    } else {
      recordAllowanceTerminalEvidence(
        config,
        operation.liquidityTokenAddress,
        operation.handlerAddress,
        block,
      );
    }
  }
}

export function upsertLiquidityOperation(
  operations: readonly LiquidityOperation[],
  operation: LiquidityOperation,
): LiquidityOperation[] {
  return [...operations.filter(({ id }) => id !== operation.id), operation];
}

export function hasBlockingLiquidityTransaction(operation: LiquidityOperation): boolean {
  if (operation.status !== "active") return false;
  return Object.values(operation.steps).some(({ status }) =>
    status === "signing" || status === "indeterminate"
  );
}

export function hasLiquidityExecutionExposure(operation: LiquidityOperation): boolean {
  const enqueue = operation.steps.enqueue.status;
  return operation.status === "queued"
    || (operation.status === "active"
      && (enqueue === "signing" || enqueue === "indeterminate"));
}

export function reservedLiquidityTokenAmount(
  operations: readonly LiquidityOperation[],
  tokenAddress: string,
): bigint {
  let total = 0n;
  for (const operation of operations) {
    if (operation.status !== "active" && operation.status !== "queued") continue;
    if (operation.kind === "add") {
      if (operation.token0Address === tokenAddress) {
        total += BigInt(operation.intent.amountsDesired[0]);
      }
      if (operation.token1Address === tokenAddress) {
        total += BigInt(operation.intent.amountsDesired[1]);
      }
    } else if (operation.liquidityTokenAddress === tokenAddress) {
      total += BigInt(operation.intent.liquidity);
    }
  }
  return total;
}

function baseOperation(
  config: AppConfig,
  kind: LiquidityOperationKind,
  now: number,
): LiquidityOperationBase {
  const step = (): LiquidityStep => ({
    status: "pending",
    transactionHash: null,
    message: null,
    updatedAt: now,
  });
  return {
    version: STORAGE_VERSION,
    id: crypto.randomUUID(),
    kind,
    status: "active",
    networkIdHex: config.networkIdHex,
    accountAddress: toHex0x(config.accountAddress),
    factoryAddress: toHex0x(config.factoryAddress),
    pairAddress: toHex0x(config.pairAddress),
    handlerAddress: toHex0x(config.handlerAddress),
    driverAddress: toHex0x(config.driverAddress),
    liquidityTokenAddress: toHex0x(config.liquidityTokenAddress),
    token0Address: toHex0x(config.tokenAAddress),
    token1Address: toHex0x(config.tokenBAddress),
    recipient: toHex0x(config.accountAddress),
    requestId: null,
    receiptBlock: null,
    terminalBlock: null,
    observedThroughBlock: null,
    steps: {
      approveToken0: step(),
      approveToken1: step(),
      approveLiquidity: step(),
      enqueue: step(),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function pruneOperations(
  operations: readonly LiquidityOperation[],
): LiquidityOperation[] {
  const unresolved = operations.filter(({ status }) => status === "active" || status === "queued");
  const terminal = operations.filter(({ status }) => status === "executed" || status === "failed")
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, TERMINAL_LIMIT);
  return [...unresolved, ...terminal].sort((left, right) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  );
}

function isCollection(
  value: unknown,
  config: Pick<AppConfig, "networkIdHex" | "accountAddress"> | AppConfig,
  scope: "pool" | "account",
): value is StoredLiquidityCollection {
  if (!isRecord(value) || value.version !== STORAGE_VERSION) return false;
  if (!Array.isArray(value.operations)) return false;
  const ids = new Set<string>();
  const requestIds = new Set<string>();
  return value.operations.every((operation) => {
    if (!isOperation(operation, config, scope) || ids.has(operation.id)) return false;
    if (operation.requestId !== null && requestIds.has(operation.requestId)) return false;
    ids.add(operation.id);
    if (operation.requestId !== null) requestIds.add(operation.requestId);
    return true;
  });
}

function isOperation(
  value: unknown,
  config: Pick<AppConfig, "networkIdHex" | "accountAddress"> | AppConfig,
  scope: "pool" | "account",
): value is LiquidityOperation {
  if (!isRecord(value)) return false;
  const steps = value.steps;
  if (
    value.version !== STORAGE_VERSION
    || typeof value.id !== "string"
    || value.id.length === 0
    || (value.kind !== "add" && value.kind !== "remove")
    || !["active", "queued", "executed", "failed"].includes(String(value.status))
    || value.networkIdHex !== config.networkIdHex
    || value.accountAddress !== toHex0x(config.accountAddress)
    || !["factoryAddress", "pairAddress", "handlerAddress", "driverAddress",
      "liquidityTokenAddress", "token0Address", "token1Address", "recipient"]
      .every((key) => typeof value[key] === "string" && HASH_PATTERN.test(value[key]))
    || value.recipient !== toHex0x(config.accountAddress)
    || String(value.token0Address) >= String(value.token1Address)
    || !nullableHash(value.requestId)
    || !(value.receiptBlock === null || unsignedInteger(value.receiptBlock))
    || !(value.terminalBlock === undefined
      || value.terminalBlock === null
      || unsignedInteger(value.terminalBlock))
    || !(value.observedThroughBlock === null || unsignedInteger(value.observedThroughBlock))
    || !isRecord(steps)
    || !["approveToken0", "approveToken1", "approveLiquidity", "enqueue"]
      .every((name) => isStep(steps[name]))
    || !validTime(value.createdAt)
    || !validTime(value.updatedAt)
    || value.updatedAt < value.createdAt
    || !isIntentAndResult(value)
    || !isCoherentLifecycle(value)
  ) return false;
  if (scope === "pool") {
    const pool = config as AppConfig;
    if (
      value.factoryAddress !== toHex0x(pool.factoryAddress)
      || value.pairAddress !== toHex0x(pool.pairAddress)
      || value.handlerAddress !== toHex0x(pool.handlerAddress)
      || value.driverAddress !== toHex0x(pool.driverAddress)
      || value.liquidityTokenAddress !== toHex0x(pool.liquidityTokenAddress)
      || value.token0Address !== toHex0x(pool.tokenAAddress)
      || value.token1Address !== toHex0x(pool.tokenBAddress)
    ) return false;
  }
  return true;
}

function isCoherentLifecycle(value: Record<string, unknown>): boolean {
  const queuedOrTerminal = value.status === "queued"
    || value.status === "executed"
    || value.status === "failed";
  const hasQueueIdentity = hash(value.requestId) && unsignedInteger(value.receiptBlock);
  if (queuedOrTerminal !== hasQueueIdentity) return false;
  if (value.terminalBlock !== undefined && value.terminalBlock !== null) {
    if (value.status !== "executed" && value.status !== "failed") return false;
    if (BigInt(value.terminalBlock as string) < BigInt(value.receiptBlock as string)) {
      return false;
    }
  }
  if (!queuedOrTerminal && value.observedThroughBlock !== null) return false;
  if (
    value.observedThroughBlock !== null
    && BigInt(value.observedThroughBlock as string) < BigInt(value.receiptBlock as string)
  ) return false;
  if (queuedOrTerminal) {
    const steps = value.steps as Record<string, unknown>;
    const enqueue = steps.enqueue as Record<string, unknown>;
    if (enqueue.status !== "committed") return false;
  }
  return value.status === "executed"
    ? value.result !== null
    : value.result === null;
}

function isIntentAndResult(value: Record<string, unknown>): boolean {
  if (!isRecord(value.intent)) return false;
  if (value.kind === "add") {
    return positivePair(value.intent.amountsDesired)
      && positivePair(value.intent.amountsMin)
      && isPositiveInteger(value.intent.estimatedLiquidity)
      && unsignedInteger(value.intent.liquidityBalanceBefore)
      && positivePair(value.intent.reservesBefore)
      && (value.result === null || (isRecord(value.result)
        && hash(value.result.transactionHash)
        && unsignedInteger(value.result.blockHeight)
        && isPositiveInteger(value.result.liquidityMinted)
        && (value.result.amountsDeposited === null
          || positivePair(value.result.amountsDeposited))
        && typeof value.result.recipientVerified === "boolean"));
  }
  return isPositiveInteger(value.intent.liquidity)
    && positivePair(value.intent.amountsMin)
    && (value.result === null || (isRecord(value.result)
      && hash(value.result.transactionHash)
      && unsignedInteger(value.result.blockHeight)
      && positivePair(value.result.amountsRedeemed)));
}

function isStep(value: unknown): value is LiquidityStep {
  if (!isRecord(value)) return false;
  if (
    !["pending", "signing", "committed", "skipped", "failed", "indeterminate"]
      .includes(String(value.status))
    || !nullableHash(value.transactionHash)
    || !(value.message === null || typeof value.message === "string")
    || !validTime(value.updatedAt)
  ) return false;
  if (value.status === "pending" || value.status === "skipped") {
    return value.transactionHash === null;
  }
  if (value.status === "committed") return value.transactionHash !== null;
  return true;
}

function operationStorageKey(operation: LiquidityOperation): string {
  return [
    "groundhog-swap:liquidity:v1",
    operation.networkIdHex,
    operation.accountAddress,
    operation.factoryAddress,
    operation.pairAddress,
  ].join(":");
}

function stringifyPair(values: readonly [bigint, bigint]): readonly [string, string] {
  return [values[0].toString(), values[1].toString()];
}

function positivePair(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every(isPositiveInteger);
}

function nullableHash(value: unknown): value is string | null {
  return value === null || hash(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function unsignedInteger(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
