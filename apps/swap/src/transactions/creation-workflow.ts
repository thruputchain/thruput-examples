import { addressFromHex, toHex0x } from "@groundhogchain/client";

import type { GlobalConfig } from "@/config";
import type { PoolCreationReview } from "@/pools/pool-creation";
import { recordAllowanceTerminalEvidence } from "@/transactions/allowance-evidence";

const STORAGE_VERSION = 3;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export const creationStepOrder = [
  "approveFunding",
  "createPool",
  "approveToken0",
  "approveToken1",
  "enqueue",
  "crank",
] as const;

export type CreationStepName = (typeof creationStepOrder)[number];
export type CreationStepStatus =
  | "pending"
  | "signing"
  | "committed"
  | "skipped"
  | "failed"
  | "indeterminate";

export interface CreationStep {
  status: CreationStepStatus;
  transactionHash: string | null;
  receiptBlock: string | null;
  message: string | null;
  updatedAt: number;
}

export interface CreationPool {
  liquidityToken: string;
  handler: string;
  driver: string;
}

export interface CreationWorkflow {
  executionMode?: "auto" | "single" | "batch";
  batchSteps?: Exclude<CreationStepName, "crank">[];
  batchPool?: CreationPool;
  version: typeof STORAGE_VERSION;
  id: string;
  networkIdHex: string;
  accountAddress: string;
  factoryAddress: string;
  routerAddress: string;
  nativeHogAddress: string;
  token0: CreationTokenIntent;
  token1: CreationTokenIntent;
  pool: CreationPool | null;
  fundingMinimum: string;
  fundingPerContract: string;
  totalFunding: string;
  status: "active" | "queued" | "executed" | "failed" | "race" | "archived";
  requestId: string | null;
  enqueueReceiptBlock: string | null;
  observedThroughBlock: string | null;
  terminalBlock: string | null;
  steps: Record<CreationStepName, CreationStep>;
  createdAt: number;
  updatedAt: number;
}

interface CreationTokenIntent {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  amount: string;
}

export class CreationWorkflowError extends Error {
  constructor() {
    super("Stored pool-creation workflow is invalid");
    this.name = "CreationWorkflowError";
  }
}

export function creationWorkflowKey(
  config: GlobalConfig,
  token0Address: string,
  token1Address: string,
): string {
  return [
    "groundhog-swap:pool-creation:v2",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    toHex0x(config.factoryAddress),
    token0Address,
    token1Address,
  ].join(":");
}

export function isAccountCreationWorkflowKey(
  config: GlobalConfig,
  key: string | null,
): boolean {
  return key?.startsWith(accountCreationWorkflowPrefix(config)) ?? false;
}

export function createCreationWorkflow(
  config: GlobalConfig,
  review: PoolCreationReview,
  now = Date.now(),
): CreationWorkflow {
  if (review.pool !== null) throw new CreationWorkflowError();
  const pending = (): CreationStep => ({
    status: "pending",
    transactionHash: null,
    receiptBlock: null,
    message: null,
    updatedAt: now,
  });
  const steps = Object.fromEntries(
    creationStepOrder.map((name) => [name, pending()]),
  ) as Record<CreationStepName, CreationStep>;
  return {
    version: STORAGE_VERSION,
    executionMode: "auto",
    id: crypto.randomUUID(),
    networkIdHex: config.networkIdHex,
    accountAddress: toHex0x(config.accountAddress),
    factoryAddress: toHex0x(config.factoryAddress),
    routerAddress: toHex0x(config.routerAddress),
    nativeHogAddress: toHex0x(config.nativeHogAddress),
    token0: tokenIntent(review.token0),
    token1: tokenIntent(review.token1),
    pool: null,
    fundingMinimum: review.fundingMinimum.toString(),
    fundingPerContract: review.fundingPerContract.toString(),
    totalFunding: review.totalFunding.toString(),
    status: "active",
    requestId: null,
    enqueueReceiptBlock: null,
    observedThroughBlock: null,
    terminalBlock: null,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

export function saveCreationWorkflow(
  config: GlobalConfig,
  workflow: CreationWorkflow,
): CreationWorkflow {
  if (!isCreationWorkflow(workflow, config)) throw new CreationWorkflowError();
  if (workflow.terminalBlock !== null && workflow.pool !== null) {
    const block = BigInt(workflow.terminalBlock);
    recordAllowanceTerminalEvidence(config, workflow.token0.address, workflow.pool.handler, block);
    recordAllowanceTerminalEvidence(config, workflow.token1.address, workflow.pool.handler, block);
  }
  window.localStorage.setItem(workflowStorageKey(workflow), JSON.stringify(workflow));
  return workflow;
}

export function sameCreationIntent(left: CreationWorkflow, right: CreationWorkflow): boolean {
  return ([
    "networkIdHex", "accountAddress", "factoryAddress", "routerAddress", "nativeHogAddress",
    "fundingMinimum", "fundingPerContract", "totalFunding",
  ] as const).every((key) => left[key] === right[key])
    && (["token0", "token1"] as const).every((token) =>
      (["address", "name", "symbol", "decimals", "amount"] as const).every((key) =>
        left[token][key] === right[token][key]
      )
    );
}

export function loadCreationWorkflow(
  config: GlobalConfig,
  token0Address: string,
  token1Address: string,
): CreationWorkflow | null {
  if (typeof window === "undefined") return null;
  const key = creationWorkflowKey(config, token0Address, token1Address);
  const stored = window.localStorage.getItem(key);
  if (stored === null) return null;
  try {
    const parsed: unknown = migrateWorkflow(JSON.parse(stored));
    if (!isCreationWorkflow(parsed, config) || workflowStorageKey(parsed) !== key) {
      throw new Error("invalid workflow");
    }
    return parsed;
  } catch {
    throw new CreationWorkflowError();
  }
}

export function loadAccountCreationWorkflows(config: GlobalConfig): CreationWorkflow[] {
  if (typeof window === "undefined") return [];
  const workflows: CreationWorkflow[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!isAccountCreationWorkflowKey(config, key)) continue;
    const stored = window.localStorage.getItem(key!);
    if (stored === null) continue;
    try {
      const parsed: unknown = migrateWorkflow(JSON.parse(stored));
      if (!isCreationWorkflow(parsed, config, "account") || workflowStorageKey(parsed) !== key) {
        throw new Error("invalid workflow");
      }
      workflows.push(parsed);
    } catch {
      throw new CreationWorkflowError();
    }
  }
  return workflows;
}

export function archiveCreationWorkflow(
  config: GlobalConfig,
  workflow: CreationWorkflow,
): CreationWorkflow {
  const stored = loadAccountCreationWorkflows(config).find(({ id }) => id === workflow.id);
  if (stored === undefined || !canArchiveCreationWorkflow(stored)) {
    throw new CreationWorkflowError();
  }
  return saveCreationWorkflow({
    ...config,
    factoryAddress: addressFromHex(stored.factoryAddress),
    routerAddress: addressFromHex(stored.routerAddress),
  }, {
    ...stored,
    status: "archived",
    updatedAt: Date.now(),
  });
}

export function canArchiveCreationWorkflow(workflow: CreationWorkflow): boolean {
  return workflow.requestId === null
    && !hasCreationExecutionExposure(workflow)
    && !hasBlockingCreationTransaction(workflow);
}

export function reservedCreationHog(workflows: readonly CreationWorkflow[]): bigint {
  return workflows.reduce((total, workflow) =>
    hasCreationFundingExposure(workflow)
      ? total + BigInt(workflow.totalFunding)
      : total, 0n);
}

export function hasCreationFundingExposure(workflow: CreationWorkflow): boolean {
  return workflow.status === "active"
    && workflow.steps.createPool.status !== "committed"
    && workflow.steps.createPool.status !== "skipped";
}

export function reservedCreationToken(
  workflows: readonly CreationWorkflow[],
  tokenAddress: string,
): bigint {
  let reserved = 0n;
  for (const workflow of workflows) {
    if (workflow.status !== "active" && workflow.status !== "queued") continue;
    if (workflow.token0.address === tokenAddress) reserved += BigInt(workflow.token0.amount);
    if (workflow.token1.address === tokenAddress) reserved += BigInt(workflow.token1.amount);
  }
  return reserved;
}

export function hasBlockingCreationTransaction(workflow: CreationWorkflow): boolean {
  if (workflow.status !== "active" && workflow.status !== "queued") return false;
  return creationStepOrder.some((name) => {
    const status = workflow.steps[name].status;
    return status === "signing" || status === "indeterminate";
  });
}

export function hasCreationExecutionExposure(workflow: CreationWorkflow): boolean {
  return workflow.status === "queued"
    || (workflow.status === "active"
      && (workflow.steps.enqueue.status === "signing"
        || workflow.steps.enqueue.status === "indeterminate"));
}

function tokenIntent(token: PoolCreationReview["token0"]): CreationTokenIntent {
  return {
    address: token.addressHex,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    amount: token.amount.toString(),
  };
}

function accountCreationWorkflowPrefix(config: GlobalConfig): string {
  return [
    "groundhog-swap:pool-creation:v2",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    "",
  ].join(":");
}

function isCreationWorkflow(
  value: unknown,
  config: GlobalConfig,
  scope: "factory" | "account" = "factory",
): value is CreationWorkflow {
  if (!isRecord(value) || value.version !== STORAGE_VERSION || !isRecord(value.steps)) return false;
  if (
    typeof value.id !== "string"
    || (value.executionMode !== undefined && !["auto", "single", "batch"].includes(String(value.executionMode)))
    || value.id.length === 0
    || value.networkIdHex !== config.networkIdHex
    || value.accountAddress !== toHex0x(config.accountAddress)
    || !isHash(value.factoryAddress)
    || !isHash(value.routerAddress)
    || value.nativeHogAddress !== toHex0x(config.nativeHogAddress)
    || (scope === "factory" && value.factoryAddress !== toHex0x(config.factoryAddress))
    || (scope === "factory" && value.routerAddress !== toHex0x(config.routerAddress))
    || !isTokenIntent(value.token0)
    || !isTokenIntent(value.token1)
    || value.token0.address >= value.token1.address
    || !(value.pool === null || isPool(value.pool))
    || !isPositiveInteger(value.fundingMinimum)
    || !isPositiveInteger(value.fundingPerContract)
    || !isPositiveInteger(value.totalFunding)
    || BigInt(value.fundingPerContract) < BigInt(value.fundingMinimum)
    || BigInt(value.totalFunding) !== BigInt(value.fundingPerContract) * 3n
    || !["active", "queued", "executed", "failed", "race", "archived"].includes(String(value.status))
    || !(value.requestId === null || isHash(value.requestId))
    || !(value.enqueueReceiptBlock === null || isPositiveInteger(value.enqueueReceiptBlock))
    || !(value.observedThroughBlock === null || isPositiveInteger(value.observedThroughBlock))
    || !(value.terminalBlock === null || isPositiveInteger(value.terminalBlock))
    || !creationStepOrder.every((name) => isStep(value.steps[name]))
    || !validTime(value.createdAt)
    || !validTime(value.updatedAt)
    || value.updatedAt < value.createdAt
  ) return false;
  if (value.executionMode === "batch") {
    if (!isPool(value.batchPool) || !Array.isArray(value.batchSteps) ||
      value.batchSteps.length < 2 || new Set(value.batchSteps).size !== value.batchSteps.length ||
      !value.batchSteps.includes("createPool") || !value.batchSteps.includes("enqueue") ||
      value.batchSteps.some((name) => !creationStepOrder.slice(0, -1).includes(name))) return false;
    const names = value.batchSteps as Exclude<CreationStepName, "crank">[];
    if (names.some((name, index) => index > 0 && creationStepOrder.indexOf(name) <= creationStepOrder.indexOf(names[index - 1]!))) return false;
    if (value.status !== "race" && names.some((name) =>
      value.steps[name].transactionHash !== value.steps.enqueue.transactionHash ||
      value.steps[name].status !== value.steps.enqueue.status)) return false;
  }
  if (value.steps.createPool.status === "committed" && value.pool === null) return false;
  if (value.pool === null && ["queued", "executed"].includes(String(value.status))) return false;
  if (value.requestId !== null && value.steps.enqueue.status !== "committed") return false;
  if (["queued", "executed"].includes(String(value.status)) && value.requestId === null) return false;
  if (value.terminalBlock !== null) {
    if (value.enqueueReceiptBlock === null || !["executed", "failed"].includes(String(value.status))) return false;
    if (BigInt(value.terminalBlock) < BigInt(value.enqueueReceiptBlock)) return false;
  }
  return true;
}

function migrateWorkflow(value: unknown): unknown {
  return isRecord(value) && value.version === 2
    ? { ...value, version: STORAGE_VERSION, executionMode: "single" }
    : value;
}

function isPool(value: unknown): value is CreationPool {
  return isRecord(value)
    && isHash(value.liquidityToken)
    && isHash(value.handler)
    && isHash(value.driver);
}

function isTokenIntent(value: unknown): value is CreationTokenIntent {
  return isRecord(value)
    && isHash(value.address)
    && typeof value.name === "string"
    && typeof value.symbol === "string"
    && typeof value.decimals === "number"
    && Number.isInteger(value.decimals)
    && value.decimals >= 0
    && value.decimals <= 255
    && isPositiveInteger(value.amount);
}

function isStep(value: unknown): value is CreationStep {
  if (!isRecord(value)) return false;
  if (
    !["pending", "signing", "committed", "skipped", "failed", "indeterminate"].includes(String(value.status))
    || !(value.transactionHash === null || isHash(value.transactionHash))
    || !(value.receiptBlock === null || isPositiveInteger(value.receiptBlock))
    || !(value.message === null || typeof value.message === "string")
    || !validTime(value.updatedAt)
  ) return false;
  if (["pending", "skipped"].includes(String(value.status))) return value.transactionHash === null;
  if (value.status === "committed") {
    return value.transactionHash !== null && value.receiptBlock !== null;
  }
  if (value.receiptBlock !== null) return false;
  return true;
}

function workflowStorageKey(workflow: CreationWorkflow): string {
  return [
    "groundhog-swap:pool-creation:v2",
    workflow.networkIdHex,
    workflow.accountAddress,
    workflow.factoryAddress,
    workflow.token0.address,
    workflow.token1.address,
  ].join(":");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
