import { toHex0x } from "@groundhogchain/client";

import type { GlobalConfig } from "@/config";
import type { PoolCreationReview } from "@/pools/pool-creation";

const STORAGE_VERSION = 1;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export const creationStepOrder = [
  "fundLiquidityToken",
  "fundPair",
  "fundHandler",
  "fundDriver",
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
  message: string | null;
  updatedAt: number;
}

export interface CreationWorkflow {
  version: typeof STORAGE_VERSION;
  id: string;
  networkIdHex: string;
  accountAddress: string;
  factoryAddress: string;
  routerAddress: string;
  nativeHogAddress: string;
  token0: CreationTokenIntent;
  token1: CreationTokenIntent;
  pool: {
    liquidityToken: string;
    pair: string;
    handler: string;
    driver: string;
  };
  fixedFundingPerContract: string;
  totalFixedFunding: string;
  status: "active" | "queued" | "executed" | "failed" | "race" | "archived";
  requestId: string | null;
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
    "groundhog-swap:pool-creation:v1",
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
  const pending = (): CreationStep => ({
    status: "pending",
    transactionHash: null,
    message: null,
    updatedAt: now,
  });
  const steps = Object.fromEntries(
    creationStepOrder.map((name) => [name, pending()]),
  ) as Record<CreationStepName, CreationStep>;
  return {
    version: STORAGE_VERSION,
    id: crypto.randomUUID(),
    networkIdHex: config.networkIdHex,
    accountAddress: toHex0x(config.accountAddress),
    factoryAddress: toHex0x(config.factoryAddress),
    routerAddress: toHex0x(config.routerAddress),
    nativeHogAddress: toHex0x(config.nativeHogAddress),
    token0: tokenIntent(review.token0),
    token1: tokenIntent(review.token1),
    pool: {
      liquidityToken: toHex0x(review.pool.liquidityToken),
      pair: toHex0x(review.pool.pair),
      handler: toHex0x(review.pool.handler),
      driver: toHex0x(review.pool.driver),
    },
    fixedFundingPerContract: review.fixedFundingPerContract.toString(),
    totalFixedFunding: review.totalFixedFunding.toString(),
    status: "active",
    requestId: null,
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
  window.localStorage.setItem(
    creationWorkflowKey(config, workflow.token0.address, workflow.token1.address),
    JSON.stringify(workflow),
  );
  return workflow;
}

export function loadCreationWorkflow(
  config: GlobalConfig,
  token0Address: string,
  token1Address: string,
): CreationWorkflow | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(
    creationWorkflowKey(config, token0Address, token1Address),
  );
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (
      !isCreationWorkflow(parsed, config)
      || workflowStorageKey(parsed)
        !== creationWorkflowKey(config, token0Address, token1Address)
    ) throw new Error("invalid workflow");
    return parsed;
  } catch {
    throw new CreationWorkflowError();
  }
}

export function loadAccountCreationWorkflows(
  config: GlobalConfig,
): CreationWorkflow[] {
  if (typeof window === "undefined") return [];
  const workflows: CreationWorkflow[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !isAccountCreationWorkflowKey(config, key)) continue;
    const value = window.localStorage.getItem(key);
    if (value === null) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        !isCreationWorkflow(parsed, config, "account")
        || workflowStorageKey(parsed) !== key
      ) {
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
  if (
    stored === undefined
    || !isCreationWorkflow(stored, config, "account")
    || !canArchiveCreationWorkflow(stored)
  ) {
    throw new CreationWorkflowError();
  }
  const archived: CreationWorkflow = {
    ...stored,
    status: "archived",
    updatedAt: Date.now(),
  };
  window.localStorage.setItem(workflowStorageKey(archived), JSON.stringify(archived));
  return archived;
}

export function canArchiveCreationWorkflow(
  workflow: CreationWorkflow,
): boolean {
  return workflow.requestId === null
    && !hasCreationExecutionExposure(workflow)
    && !hasBlockingCreationTransaction(workflow);
}

export function reservedCreationHog(workflows: readonly CreationWorkflow[]): bigint {
  return workflows.reduce((total, workflow) => {
    if (workflow.status !== "active") return total;
    const remainingTransfers = [
      workflow.steps.fundLiquidityToken,
      workflow.steps.fundPair,
      workflow.steps.fundHandler,
      workflow.steps.fundDriver,
    ].filter(({ status }) => status !== "committed").length;
    return total + BigInt(workflow.fixedFundingPerContract) * BigInt(remainingTransfers);
  }, 0n);
}

export function reservedCreationToken(
  workflows: readonly CreationWorkflow[],
  tokenAddress: string,
): bigint {
  let reserved = 0n;
  for (const workflow of workflows) {
    if (
      workflow.status !== "active"
      && workflow.status !== "queued"
      && !(workflow.status === "race" && workflow.requestId !== null)
    ) continue;
    if (workflow.token0.address === tokenAddress) reserved += BigInt(workflow.token0.amount);
    if (workflow.token1.address === tokenAddress) reserved += BigInt(workflow.token1.amount);
  }
  return reserved;
}

export function hasBlockingCreationTransaction(
  workflow: CreationWorkflow,
): boolean {
  if (workflow.status !== "active" && workflow.status !== "queued") return false;
  return creationStepOrder.some((name) =>
    workflow.steps[name].status === "signing"
    || workflow.steps[name].status === "indeterminate"
  );
}

export function hasCreationExecutionExposure(
  workflow: CreationWorkflow,
): boolean {
  return workflow.status === "queued"
    || (workflow.status === "race" && workflow.requestId !== null);
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
    "groundhog-swap:pool-creation:v1",
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
  if (!isRecord(value) || value.version !== STORAGE_VERSION) return false;
  const steps = value.steps;
  if (
    typeof value.id !== "string"
    || value.id.length === 0
    || value.networkIdHex !== config.networkIdHex
    || value.accountAddress !== toHex0x(config.accountAddress)
    || typeof value.factoryAddress !== "string"
    || !HASH_PATTERN.test(value.factoryAddress)
    || typeof value.routerAddress !== "string"
    || !HASH_PATTERN.test(value.routerAddress)
    || typeof value.nativeHogAddress !== "string"
    || !HASH_PATTERN.test(value.nativeHogAddress)
    || (scope === "factory"
      && value.factoryAddress !== toHex0x(config.factoryAddress))
    || (scope === "factory"
      && value.routerAddress !== toHex0x(config.routerAddress))
    || value.nativeHogAddress !== toHex0x(config.nativeHogAddress)
    || !isTokenIntent(value.token0)
    || !isTokenIntent(value.token1)
    || value.token0.address >= value.token1.address
    || !isPool(value.pool)
    || !isPositiveInteger(value.fixedFundingPerContract)
    || !isPositiveInteger(value.totalFixedFunding)
    || BigInt(value.totalFixedFunding) !== BigInt(value.fixedFundingPerContract) * 4n
    || !["active", "queued", "executed", "failed", "race", "archived"]
      .includes(String(value.status))
    || !(value.requestId === null
      || (typeof value.requestId === "string" && HASH_PATTERN.test(value.requestId)))
    || !isRecord(steps)
    || !creationStepOrder.every((name) => isStep(steps[name]))
    || !validTime(value.createdAt)
    || !validTime(value.updatedAt)
    || value.updatedAt < value.createdAt
  ) return false;
  const enqueue = steps.enqueue as CreationStep;
  const crank = steps.crank as CreationStep;
  if (
    (value.requestId !== null && enqueue.status !== "committed")
    || (["queued", "executed"].includes(String(value.status))
      && (value.requestId === null || enqueue.status !== "committed"))
    || (crank.status !== "pending"
      && (value.requestId === null || enqueue.status !== "committed"))
  ) return false;
  return true;
}

function isTokenIntent(value: unknown): value is CreationTokenIntent {
  return isRecord(value)
    && typeof value.address === "string"
    && HASH_PATTERN.test(value.address)
    && typeof value.name === "string"
    && typeof value.symbol === "string"
    && typeof value.decimals === "number"
    && Number.isInteger(value.decimals)
    && value.decimals >= 0
    && value.decimals <= 255
    && isPositiveInteger(value.amount);
}

function isPool(value: unknown): value is CreationWorkflow["pool"] {
  return isRecord(value)
    && ["liquidityToken", "pair", "handler", "driver"].every((key) =>
      typeof value[key] === "string" && HASH_PATTERN.test(value[key])
    );
}

function isStep(value: unknown): value is CreationStep {
  if (!(isRecord(value)
    && ["pending", "signing", "committed", "skipped", "failed", "indeterminate"]
      .includes(String(value.status))
    && (value.transactionHash === null
      || (typeof value.transactionHash === "string"
        && HASH_PATTERN.test(value.transactionHash)))
    && (value.message === null || typeof value.message === "string")
    && validTime(value.updatedAt))) return false;
  if (value.status === "committed") return value.transactionHash !== null;
  if (value.status === "skipped" || value.status === "pending") {
    return value.transactionHash === null;
  }
  return true;
}

function isPositiveInteger(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowStorageKey(workflow: CreationWorkflow): string {
  return [
    "groundhog-swap:pool-creation:v1",
    workflow.networkIdHex,
    workflow.accountAddress,
    workflow.factoryAddress,
    workflow.token0.address,
    workflow.token1.address,
  ].join(":");
}
