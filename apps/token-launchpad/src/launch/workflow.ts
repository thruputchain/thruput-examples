import { toHex0x } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import type { FactoryReview } from "@/contracts/launchpad-client";
import { userErrorMessage } from "@/errors";
import type { ParsedToken } from "@/launch/form";
import { MAX_SIGNED_AMOUNT } from "@/runtime";

export const WORKFLOW_VERSION = 2 as const;
const LEGACY_WORKFLOW_VERSION = 1;
const HASH = /^0x[0-9a-f]{64}$/;

export type StepStatus =
  "idle" | "signing" | "pending" | "committed" | "failed" | "uncertain";

export interface WorkflowStep {
  status: StepStatus;
  hash: string | null;
}

export interface LaunchWorkflow {
  version: typeof WORKFLOW_VERSION;
  id: string;
  revision: number;
  networkIdHex: string;
  factoryAddressHex: string;
  creatorAddressHex: string;
  nonceHex: string;
  token: {
    name: string;
    symbol: string;
    decimals: number;
    initialSupply: string;
  };
  predictedAddressHex: string;
  reviewedNativeTokenHex: string;
  reviewedTokenCodeHashHex: string;
  requiredTokenFunding: string;
  reviewedCreationFee: string;
  reviewedFeeRecipientHex: string | null;
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
  createdAddressHex: string | null;
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
    config.networkIdHex,
    toHex0x(config.factoryAddress),
    toHex0x(config.accountAddress),
  ].join(":");
}

export function workflowLockName(config: AppConfig): string {
  return [
    "groundhog-token-launchpad:write:v1",
    config.networkIdHex,
    toHex0x(config.accountAddress),
  ].join(":");
}

export function workflowSessionLockName(config: AppConfig): string {
  return [
    "groundhog-token-launchpad:write-session:v1",
    config.networkIdHex,
    toHex0x(config.accountAddress),
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
    id: crypto.randomUUID(),
    revision: 0,
    networkIdHex: config.networkIdHex,
    factoryAddressHex: toHex0x(config.factoryAddress),
    creatorAddressHex: toHex0x(config.accountAddress),
    nonceHex: toHex0x(nonce),
    token: {
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      initialSupply: token.initialSupply.toString(),
    },
    predictedAddressHex: review.predictedAddressHex,
    reviewedNativeTokenHex: toHex0x(review.config.native_token),
    reviewedTokenCodeHashHex: toHex0x(review.config.token_code_hash),
    requiredTokenFunding: review.config.required_token_funding.toString(),
    reviewedCreationFee: review.config.creation_fee.toString(),
    reviewedFeeRecipientHex:
      review.config.fee_recipient === null
        ? null
        : toHex0x(review.config.fee_recipient),
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
    createdAddressHex: null,
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
    value.createdAddressHex === null &&
    value.creationBlock === null &&
    isPristineVerification(value.verification)
  );
}

export function assertWorkflowScope(
  workflow: LaunchWorkflow,
  config: AppConfig,
): void {
  if (
    workflow.networkIdHex !== config.networkIdHex ||
    workflow.factoryAddressHex !== toHex0x(config.factoryAddress) ||
    workflow.creatorAddressHex !== toHex0x(config.accountAddress)
  ) {
    throw new WorkflowStorageError(
      "The saved launch workflow belongs to another account or network",
    );
  }
}

export function workflowIntent(workflow: LaunchWorkflow): string {
  return JSON.stringify([
    workflow.networkIdHex,
    workflow.factoryAddressHex,
    workflow.creatorAddressHex,
    workflow.nonceHex,
    workflow.token.name,
    workflow.token.symbol,
    workflow.token.decimals,
    workflow.token.initialSupply,
    workflow.predictedAddressHex,
    workflow.reviewedNativeTokenHex,
    workflow.reviewedTokenCodeHashHex,
    workflow.requiredTokenFunding,
    workflow.reviewedCreationFee,
    workflow.reviewedFeeRecipientHex,
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
    networkIdHex: networkHex(value.networkIdHex),
    factoryAddressHex: hex(value.factoryAddressHex),
    creatorAddressHex: hex(value.creatorAddressHex),
    nonceHex: hex(value.nonceHex),
    token: {
      name: stringField(token, "name"),
      symbol: stringField(token, "symbol"),
      decimals: integerField(token, "decimals", 0, 18),
      initialSupply: signedAmountField(token, "initialSupply"),
    },
    predictedAddressHex: hex(value.predictedAddressHex),
    reviewedNativeTokenHex: hex(value.reviewedNativeTokenHex),
    reviewedTokenCodeHashHex: hex(value.reviewedTokenCodeHashHex),
    requiredTokenFunding: signedAmount(value.requiredTokenFunding),
    reviewedCreationFee: signedAmount(value.reviewedCreationFee),
    reviewedFeeRecipientHex:
      value.reviewedFeeRecipientHex === null
        ? null
        : hex(value.reviewedFeeRecipientHex),
    reviewedFundingAmount: signedAmount(value.reviewedFundingAmount),
    reviewedReserve: unsigned(value.reviewedReserve),
    plannedFundingAmount: signedAmount(
      value.plannedFundingAmount ?? value.reviewedFundingAmount,
    ),
    plannedReserve: unsigned(value.plannedReserve ?? value.reviewedReserve),
    funding: step(value.funding),
    creation: step(value.creation),
    verification: verification(value.verification),
    createdAddressHex:
      value.createdAddressHex === null ? null : hex(value.createdAddressHex),
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
    workflow.createdAddressHex !== null && workflow.creationBlock !== null;
  if (
    (workflow.creation.status === "committed") !== hasCreationEvidence ||
    (workflow.creation.status === "committed" &&
      workflow.funding.status !== "committed") ||
    (workflow.createdAddressHex !== null &&
      workflow.createdAddressHex !== workflow.predictedAddressHex) ||
    (workflow.creation.status === "committed" &&
      workflow.verification.status === "pending") ||
    (workflow.creation.status !== "committed" &&
      workflow.verification.status !== "pending")
  ) {
    throw new WorkflowStorageError();
  }
  return workflow;
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
  if (hash !== null && (typeof hash !== "string" || !HASH.test(hash))) {
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

function hex(value: unknown): string {
  const parsed = string(value);
  if (!HASH.test(parsed)) throw new WorkflowStorageError();
  return parsed;
}

function networkHex(value: unknown): string {
  const parsed = string(value);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new WorkflowStorageError();
  return parsed;
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
