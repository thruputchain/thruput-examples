import {
  addressFromBase58,
  hashFromBase58,
  toBase58,
  toHex0x,
} from "@thruputchain/client";

import type { AppConfig } from "@/config";
import type { FactoryReview } from "@/contracts/launchpad-client";
import { userErrorMessage } from "@/lib/errors";
import type { ParsedToken } from "@/launch/form";
import { MAX_SIGNED_AMOUNT } from "../../shared/amount";

const WORKFLOW_VERSION = 4 as const;
const LEGACY_WORKFLOW_VERSION = 1;
const NONCE = /^0x[0-9a-f]{64}$/;

export type StepStatus =
  "idle" | "signing" | "pending" | "committed" | "failed" | "uncertain";

export interface WorkflowStep {
  status: StepStatus;
  hash: string | null;
}

export interface LaunchWorkflow {
  executionMode: "auto" | "single" | "batch";
  version: typeof WORKFLOW_VERSION;
  id: string;
  revision: number;
  networkId: string;
  factoryAddress: string;
  creatorAddress: string;
  nonceHex: string;
  token: {
    name: string;
    symbol: string;
    decimals: number;
    initialSupply: string;
  };
  predictedAddress: string;
  reviewedNativeToken: string;
  reviewedTokenCodeHash: string;
  requiredTokenFunding: string;
  reviewedCreationFee: string;
  reviewedFeeRecipient: string | null;
  reviewedFundingAmount: string;
  reviewedReserve: string;
  plannedFundingAmount: string;
  plannedReserve: string;
  funding: WorkflowStep;
  creation: WorkflowStep;
  verification: {
    status: "pending" | "complete" | "incomplete";
    message: string | null;
    totalSupply: string | null;
    holderBalance: string | null;
  };
  createdAddress: string | null;
  creationBlock: string | null;
  error: string | null;
}

export class WorkflowStorageError extends Error {
  constructor(message = "The launch workflow could not be safely stored") {
    super(message);
    this.name = "WorkflowStorageError";
  }
}

export function workflowStorageKey(config: AppConfig): string {
  return [
    "groundhog-token-launchpad:workflow:v1",
    config.networkId,
    toBase58(config.factoryAddress),
    toBase58(config.accountAddress),
  ].join(":");
}

export function workflowLockName(config: AppConfig): string {
  return [
    "groundhog-token-launchpad:write:v1",
    config.networkId,
    toBase58(config.accountAddress),
  ].join(":");
}

export function workflowSessionLockName(config: AppConfig): string {
  return [
    "groundhog-token-launchpad:write-session:v1",
    config.networkId,
    toBase58(config.accountAddress),
  ].join(":");
}

export function createWorkflow(
  config: AppConfig,
  token: ParsedToken,
  nonce: Uint8Array,
  review: FactoryReview,
): LaunchWorkflow {
  return {
    version: WORKFLOW_VERSION,
    executionMode: "auto",
    id: crypto.randomUUID(),
    revision: 0,
    networkId: config.networkId,
    factoryAddress: toBase58(config.factoryAddress),
    creatorAddress: toBase58(config.accountAddress),
    nonceHex: toHex0x(nonce),
    token: {
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      initialSupply: token.initialSupply.toString(),
    },
    predictedAddress: toBase58(review.predictedAddress),
    reviewedNativeToken: toBase58(review.config.native_token),
    reviewedTokenCodeHash: toBase58(review.config.token_code_hash),
    requiredTokenFunding: review.config.required_token_funding.toString(),
    reviewedCreationFee: review.config.creation_fee.toString(),
    reviewedFeeRecipient:
      review.config.fee_recipient === null
        ? null
        : toBase58(review.config.fee_recipient),
    reviewedFundingAmount: review.fundingAmount.toString(),
    reviewedReserve: review.currentReserve.toString(),
    plannedFundingAmount: review.fundingAmount.toString(),
    plannedReserve: review.currentReserve.toString(),
    funding: { status: "idle", hash: null },
    creation: { status: "idle", hash: null },
    verification: {
      status: "pending",
      message: null,
      totalSupply: null,
      holderBalance: null,
    },
    createdAddress: null,
    creationBlock: null,
    error: null,
  };
}

export function saveWorkflow(
  storage: Pick<Storage, "setItem">,
  key: string,
  workflow: LaunchWorkflow,
): void {
  try {
    storage.setItem(key, JSON.stringify(workflow));
  } catch {
    throw new WorkflowStorageError();
  }
}

export async function withWorkflowLock<T>(
  config: AppConfig,
  action: () => Promise<T>,
  locks: LockManager | undefined = navigator.locks,
): Promise<T> {
  if (!locks) {
    throw new Error("This browser cannot safely serialize launch transactions");
  }
  return locks.request(workflowLockName(config), action);
}

export async function withWorkflowSessionLock<T>(
  config: AppConfig,
  action: () => Promise<T>,
  locks: LockManager | undefined = navigator.locks,
): Promise<T> {
  if (!locks) {
    throw new Error("This browser cannot safely serialize launch transactions");
  }
  return locks.request(workflowSessionLockName(config), action);
}

export function loadWorkflow(
  storage: Pick<Storage, "getItem">,
  key: string,
): LaunchWorkflow | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(key);
  } catch {
    throw new WorkflowStorageError(
      "The saved launch workflow could not be read",
    );
  }
  if (serialized === null) return null;
  try {
    return parseWorkflow(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof WorkflowStorageError) throw error;
    throw new WorkflowStorageError("The saved launch workflow is invalid");
  }
}

export function canDiscardInvalidStoredWorkflow(
  storage: Pick<Storage, "getItem">,
  key: string,
): boolean {
  let value: unknown;
  try {
    const serialized = storage.getItem(key);
    if (serialized === null) return false;
    value = JSON.parse(serialized);
  } catch {
    return false;
  }
  if (!isRecord(value) || value.version !== LEGACY_WORKFLOW_VERSION) {
    return false;
  }
  return (
    isPristineStep(value.funding) &&
    isPristineStep(value.creation) &&
    value.createdAddress === null &&
    value.creationBlock === null &&
    isPristineVerification(value.verification)
  );
}

export function assertWorkflowScope(
  workflow: LaunchWorkflow,
  config: AppConfig,
): void {
  if (
    workflow.networkId !== config.networkId ||
    workflow.factoryAddress !== toBase58(config.factoryAddress) ||
    workflow.creatorAddress !== toBase58(config.accountAddress)
  ) {
    throw new WorkflowStorageError(
      "The saved launch workflow belongs to another account or network",
    );
  }
}

export function workflowIntent(workflow: LaunchWorkflow): string {
  return JSON.stringify([
    workflow.networkId,
    workflow.factoryAddress,
    workflow.creatorAddress,
    workflow.nonceHex,
    workflow.token.name,
    workflow.token.symbol,
    workflow.token.decimals,
    workflow.token.initialSupply,
    workflow.predictedAddress,
    workflow.reviewedNativeToken,
    workflow.reviewedTokenCodeHash,
    workflow.requiredTokenFunding,
    workflow.reviewedCreationFee,
    workflow.reviewedFeeRecipient,
    workflow.plannedFundingAmount,
    workflow.plannedReserve,
  ]);
}

function parseWorkflow(value: unknown): LaunchWorkflow {
  if (!isRecord(value) || value.version !== WORKFLOW_VERSION) {
    throw new WorkflowStorageError(
      "The saved launch workflow version is unsupported",
    );
  }
  const token = value.token;
  const workflow: LaunchWorkflow = {
    version: WORKFLOW_VERSION,
    id: string(value.id),
    revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER),
    networkId: hash(value.networkId),
    factoryAddress: address(value.factoryAddress),
    creatorAddress: address(value.creatorAddress),
    nonceHex: nonceHex(value.nonceHex),
    token: {
      name: stringField(token, "name"),
      symbol: stringField(token, "symbol"),
      decimals: integerField(token, "decimals", 0, 18),
      initialSupply: signedAmountField(token, "initialSupply"),
    },
    predictedAddress: address(value.predictedAddress),
    reviewedNativeToken: address(value.reviewedNativeToken),
    reviewedTokenCodeHash: hash(value.reviewedTokenCodeHash),
    requiredTokenFunding: signedAmount(value.requiredTokenFunding),
    reviewedCreationFee: signedAmount(value.reviewedCreationFee),
    reviewedFeeRecipient:
      value.reviewedFeeRecipient === null
        ? null
        : address(value.reviewedFeeRecipient),
    reviewedFundingAmount: signedAmount(value.reviewedFundingAmount),
    reviewedReserve: unsigned(value.reviewedReserve),
    plannedFundingAmount: signedAmount(
      value.plannedFundingAmount ?? value.reviewedFundingAmount,
    ),
    plannedReserve: unsigned(value.plannedReserve ?? value.reviewedReserve),
    executionMode:
      value.executionMode === undefined
        ? "single"
        : executionMode(value.executionMode),
    funding: step(value.funding),
    creation: step(value.creation),
    verification: verification(value.verification),
    createdAddress:
      value.createdAddress === null ? null : address(value.createdAddress),
    creationBlock:
      value.creationBlock === null ? null : unsigned(value.creationBlock),
    error:
      value.error === null
        ? null
        : userErrorMessage(
            new Error(string(value.error)),
            "The saved launch failed",
          ),
  };
  if (
    workflow.id.length === 0 ||
    !validMetadata(workflow.token.name, 100) ||
    !validMetadata(workflow.token.symbol, 10) ||
    BigInt(workflow.token.initialSupply) > MAX_SIGNED_AMOUNT ||
    BigInt(workflow.requiredTokenFunding) === 0n
  ) {
    throw new WorkflowStorageError();
  }
  if (
    workflow.creation.status === "committed" &&
    workflow.creation.hash === null
  ) {
    throw new WorkflowStorageError();
  }
  const hasCreationEvidence =
    workflow.createdAddress !== null && workflow.creationBlock !== null;
  if (
    (workflow.executionMode === "batch" &&
      (workflow.funding.status !== workflow.creation.status ||
        workflow.funding.hash !== workflow.creation.hash)) ||
    (workflow.creation.status === "committed") !== hasCreationEvidence ||
    (workflow.creation.status === "committed" &&
      workflow.funding.status !== "committed") ||
    (workflow.createdAddress !== null &&
      workflow.createdAddress !== workflow.predictedAddress) ||
    (workflow.creation.status === "committed" &&
      workflow.verification.status === "pending") ||
    (workflow.creation.status !== "committed" &&
      workflow.verification.status !== "pending")
  ) {
    throw new WorkflowStorageError();
  }
  return workflow;
}

function executionMode(value: unknown): LaunchWorkflow["executionMode"] {
  if (value !== "auto" && value !== "single" && value !== "batch")
    throw new WorkflowStorageError();
  return value;
}

function step(value: unknown): WorkflowStep {
  if (!isRecord(value)) throw new WorkflowStorageError();
  const statuses: StepStatus[] = [
    "idle",
    "signing",
    "pending",
    "committed",
    "failed",
    "uncertain",
  ];
  if (
    typeof value.status !== "string" ||
    !statuses.includes(value.status as StepStatus)
  ) {
    throw new WorkflowStorageError();
  }
  const hash = value.hash;
  if (
    hash !== null &&
    (typeof hash !== "string" || !isBase58(hash, hashFromBase58))
  ) {
    throw new WorkflowStorageError();
  }
  if (
    ((value.status === "idle" || value.status === "signing") &&
      hash !== null) ||
    ((value.status === "pending" ||
      value.status === "uncertain" ||
      value.status === "failed") &&
      hash === null)
  ) {
    throw new WorkflowStorageError();
  }
  return {
    status: value.status as StepStatus,
    hash: hash as string | null,
  };
}

function isPristineStep(value: unknown): boolean {
  return isRecord(value) && value.status === "idle" && value.hash === null;
}

function isPristineVerification(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.status === "pending" &&
    value.message === null &&
    value.totalSupply === null &&
    value.holderBalance === null
  );
}

function verification(value: unknown): LaunchWorkflow["verification"] {
  if (!isRecord(value)) throw new WorkflowStorageError();
  if (
    value.status !== "pending" &&
    value.status !== "complete" &&
    value.status !== "incomplete"
  ) {
    throw new WorkflowStorageError();
  }
  return {
    status: value.status,
    message: value.message === null ? null : string(value.message),
    totalSupply:
      value.totalSupply === null ? null : unsigned(value.totalSupply),
    holderBalance:
      value.holderBalance === null ? null : unsigned(value.holderBalance),
  };
}

function nonceHex(value: unknown): string {
  const parsed = string(value);
  if (!NONCE.test(parsed)) throw new WorkflowStorageError();
  return parsed;
}

function address(value: unknown): string {
  const parsed = string(value);
  if (!isBase58(parsed, addressFromBase58)) throw new WorkflowStorageError();
  return parsed;
}

function hash(value: unknown): string {
  const parsed = string(value);
  if (!isBase58(parsed, hashFromBase58)) throw new WorkflowStorageError();
  return parsed;
}

// Identifiers are compared as text, so accept only the canonical encoding.
function isBase58(value: string, decode: (text: string) => Uint8Array) {
  try {
    return toBase58(decode(value)) === value;
  } catch {
    return false;
  }
}

function unsigned(value: unknown): string {
  const parsed = string(value);
  if (!/^\d+$/.test(parsed)) throw new WorkflowStorageError();
  return parsed;
}

function signedAmount(value: unknown): string {
  const parsed = unsigned(value);
  if (BigInt(parsed) > MAX_SIGNED_AMOUNT) throw new WorkflowStorageError();
  return parsed;
}

function validMetadata(value: string, maximumBytes: number): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= maximumBytes
  );
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new WorkflowStorageError();
  return value;
}

function stringField(value: unknown, name: string): string {
  if (!isRecord(value)) throw new WorkflowStorageError();
  return string(value[name]);
}

function integerField(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!isRecord(value)) throw new WorkflowStorageError();
  const field = value[name];
  if (
    !Number.isInteger(field) ||
    (field as number) < minimum ||
    (field as number) > maximum
  ) {
    throw new WorkflowStorageError();
  }
  return field as number;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new WorkflowStorageError();
  }
  return value as number;
}

function signedAmountField(value: unknown, name: string): string {
  if (!isRecord(value)) throw new WorkflowStorageError();
  return signedAmount(value[name]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
