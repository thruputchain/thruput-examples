import { toHex0x } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import {
  clearOutstandingRequest,
  loadOutstandingRequest,
  withOutstandingRequestLock,
  type OutstandingRequest,
} from "@/transactions/outstanding-request";

const STORAGE_VERSION = 2;
const TERMINAL_HISTORY_LIMIT = 50;
const LEGACY_LOCAL_ID = "legacy-outstanding-request";
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const I128_MAX = (1n << 127n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export class RequestCollectionError extends Error {
  constructor() {
    super("Stored swap request history is invalid");
    this.name = "RequestCollectionError";
  }
}

export type RequestStatus = OutstandingRequest["status"] | "executed" | "failed";

export type RequestExecution =
  | {
      kind: "executed";
      transactionHash: string;
      blockHeight: bigint;
      amountIn: bigint;
      amountOut: bigint;
    }
  | {
      kind: "failed";
      transactionHash: string;
      blockHeight: bigint;
    };

export interface RequestRecord extends Omit<OutstandingRequest, "status"> {
  localId: string;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  observedThroughBlock: bigint | null;
  snapshotInferenceEligible: boolean;
  execution: RequestExecution | null;
}

interface StoredCollection {
  version: typeof STORAGE_VERSION;
  requests: StoredRequest[];
}

interface StoredRequest {
  localId: string;
  status: RequestStatus;
  phase: RequestRecord["phase"];
  amountIn: string;
  amountOutMin: string;
  transactionHash: string | null;
  receiptBlock: string | null;
  requestId: string | null;
  visibleObservationMs: number;
  observationBaseline: {
    chainHeight: string;
    inputBalance: string;
    outputBalance: string;
    inputAllowance: string;
    reserveIn: string;
    reserveOut: string;
  } | null;
  criteria: RequestRecord["criteria"];
  createdAt: number;
  updatedAt: number;
  observedThroughBlock?: string | null;
  snapshotInferenceEligible?: boolean;
  execution:
    | {
        kind: "executed";
        transactionHash: string;
        blockHeight: string;
        amountIn: string;
        amountOut: string;
      }
    | {
        kind: "failed";
        transactionHash: string;
        blockHeight: string;
      }
    | null;
}

export function requestCollectionKey(config: AppConfig): string {
  return [
    "groundhog-swap:requests:v2",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    toHex0x(config.pairAddress),
  ].join(":");
}

export function createRequestRecord(
  request: OutstandingRequest,
  options: { localId?: string; now?: number } = {},
): RequestRecord {
  const now = options.now ?? Date.now();
  return {
    ...request,
    localId: options.localId ?? crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    observedThroughBlock: null,
    snapshotInferenceEligible: request.observationBaseline !== null,
    execution: null,
  };
}

export function loadRequestCollection(config: AppConfig): RequestRecord[] {
  if (typeof window === "undefined") return [];

  const key = requestCollectionKey(config);
  const stored = window.localStorage.getItem(key);
  if (stored !== null) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (!isStoredCollection(parsed, config)) {
        throw new Error("invalid request collection");
      }
      return parsed.requests.map(fromStoredRequest);
    } catch {
      throw new RequestCollectionError();
    }
  }
  return [];
}

export function saveRequestCollection(
  config: AppConfig,
  requests: readonly RequestRecord[],
): RequestRecord[] {
  const pruned = pruneRequestHistory(requests);
  const stored: StoredCollection = {
    version: STORAGE_VERSION,
    requests: pruned.map(toStoredRequest),
  };
  if (!isStoredCollection(stored, config)) {
    throw new RequestCollectionError();
  }
  window.localStorage.setItem(requestCollectionKey(config), JSON.stringify(stored));
  return pruned;
}

export async function mutateRequestCollection(
  config: AppConfig,
  mutate: (current: readonly RequestRecord[]) => readonly RequestRecord[],
): Promise<RequestRecord[]> {
  return withRequestCollectionLock(config, () => {
    const current = loadOrMigrateRequestCollection(config);
    return saveRequestCollection(config, mutate(current));
  });
}

export async function migrateRequestCollection(
  config: AppConfig,
): Promise<RequestRecord[]> {
  return withRequestCollectionLock(config, () =>
    loadOrMigrateRequestCollection(config)
  );
}

export async function withRequestCollectionLock<T>(
  config: AppConfig,
  action: () => Promise<T> | T,
): Promise<T> {
  return withOutstandingRequestLock(config, async () => action());
}

export function upsertRequest(
  requests: readonly RequestRecord[],
  request: RequestRecord,
): RequestRecord[] {
  const index = requests.findIndex(({ localId }) => localId === request.localId);
  if (index === -1) return [...requests, request];
  return requests.map((current, currentIndex) =>
    currentIndex === index ? request : current
  );
}

export function dismissTerminalRequest(
  requests: readonly RequestRecord[],
  localId: string,
): RequestRecord[] {
  return requests.filter(
    (request) => request.localId !== localId || !isTerminalRequest(request),
  );
}

export function pruneRequestHistory(
  requests: readonly RequestRecord[],
): RequestRecord[] {
  const terminal = requests.filter(isTerminalRequest);
  if (terminal.length <= TERMINAL_HISTORY_LIMIT) return [...requests];

  const remove = new Set(
    [...terminal]
      .sort(compareOldestFirst)
      .slice(0, terminal.length - TERMINAL_HISTORY_LIMIT)
      .map(({ localId }) => localId),
  );
  return requests.filter(({ localId }) => !remove.has(localId));
}

export function isTerminalRequest(request: RequestRecord): boolean {
  return request.status === "committedFailure"
    || request.status === "executed"
    || request.status === "failed";
}

function loadOrMigrateRequestCollection(config: AppConfig): RequestRecord[] {
  const current = loadRequestCollection(config);
  const legacy = loadOutstandingRequest(config);
  if (legacy === null) return current;

  const duplicate = current.some((request) => sameLegacyRequest(request, legacy));
  if (duplicate) {
    clearOutstandingRequest(config);
    return current;
  }

  const migrated = createRequestRecord(
    legacy,
    current.length === 0
      ? { localId: LEGACY_LOCAL_ID, now: Date.now() }
      : { now: Date.now() },
  );
  const next = saveRequestCollection(config, [...current, migrated]);
  clearOutstandingRequest(config);
  return next;
}

function sameLegacyRequest(
  current: RequestRecord,
  legacy: OutstandingRequest,
): boolean {
  if (legacy.requestId !== null) return current.requestId === legacy.requestId;
  if (legacy.transactionHash !== null) {
    return current.transactionHash === legacy.transactionHash
      && current.phase === legacy.phase;
  }
  return current.transactionHash === null
    && current.requestId === null
    && current.status === legacy.status
    && current.phase === legacy.phase
    && current.intent.amountIn === legacy.intent.amountIn
    && current.intent.amountOutMin === legacy.intent.amountOutMin;
}

function compareOldestFirst(left: RequestRecord, right: RequestRecord): number {
  return left.updatedAt - right.updatedAt
    || left.createdAt - right.createdAt
    || left.localId.localeCompare(right.localId);
}

function toStoredRequest(request: RequestRecord): StoredRequest {
  return {
    localId: request.localId,
    status: request.status,
    phase: request.phase,
    amountIn: request.intent.amountIn.toString(),
    amountOutMin: request.intent.amountOutMin.toString(),
    transactionHash: request.transactionHash,
    receiptBlock: request.receiptBlock?.toString() ?? null,
    requestId: request.requestId,
    visibleObservationMs: request.visibleObservationMs,
    observationBaseline: request.observationBaseline === null
      ? null
      : {
          chainHeight: request.observationBaseline.chainHeight.toString(),
          inputBalance: request.observationBaseline.inputBalance.toString(),
          outputBalance: request.observationBaseline.outputBalance.toString(),
          inputAllowance: request.observationBaseline.inputAllowance.toString(),
          reserveIn: request.observationBaseline.reserveIn.toString(),
          reserveOut: request.observationBaseline.reserveOut.toString(),
        },
    criteria: request.criteria,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    observedThroughBlock: request.observedThroughBlock?.toString() ?? null,
    snapshotInferenceEligible: request.snapshotInferenceEligible,
    execution: toStoredExecution(request.execution),
  };
}

function toStoredExecution(
  execution: RequestExecution | null,
): StoredRequest["execution"] {
  if (execution === null) return null;
  if (execution.kind === "failed") {
    return {
      kind: "failed",
      transactionHash: execution.transactionHash,
      blockHeight: execution.blockHeight.toString(),
    };
  }
  return {
    kind: "executed",
    transactionHash: execution.transactionHash,
    blockHeight: execution.blockHeight.toString(),
    amountIn: execution.amountIn.toString(),
    amountOut: execution.amountOut.toString(),
  };
}

function fromStoredRequest(request: StoredRequest): RequestRecord {
  return {
    localId: request.localId,
    status: request.status,
    phase: request.phase,
    intent: {
      amountIn: BigInt(request.amountIn),
      amountOutMin: BigInt(request.amountOutMin),
    },
    transactionHash: request.transactionHash,
    receiptBlock: request.receiptBlock === null ? null : BigInt(request.receiptBlock),
    requestId: request.requestId,
    visibleObservationMs: request.visibleObservationMs,
    observationBaseline: request.observationBaseline === null
      ? null
      : {
          chainHeight: BigInt(request.observationBaseline.chainHeight),
          inputBalance: BigInt(request.observationBaseline.inputBalance),
          outputBalance: BigInt(request.observationBaseline.outputBalance),
          inputAllowance: BigInt(request.observationBaseline.inputAllowance),
          reserveIn: BigInt(request.observationBaseline.reserveIn),
          reserveOut: BigInt(request.observationBaseline.reserveOut),
        },
    criteria: request.criteria,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    observedThroughBlock: request.observedThroughBlock == null
      ? null
      : BigInt(request.observedThroughBlock),
    snapshotInferenceEligible: request.snapshotInferenceEligible
      ?? request.observationBaseline !== null,
    execution: request.execution === null
      ? null
      : request.execution.kind === "executed"
        ? {
            kind: "executed",
            transactionHash: request.execution.transactionHash,
            blockHeight: BigInt(request.execution.blockHeight),
            amountIn: BigInt(request.execution.amountIn),
            amountOut: BigInt(request.execution.amountOut),
          }
        : {
            kind: "failed",
            transactionHash: request.execution.transactionHash,
            blockHeight: BigInt(request.execution.blockHeight),
          },
  };
}

function isStoredCollection(
  value: unknown,
  config: AppConfig,
): value is StoredCollection {
  if (!isRecord(value) || value.version !== STORAGE_VERSION) return false;
  if (!Array.isArray(value.requests)) return false;

  const localIds = new Set<string>();
  const requestIds = new Set<string>();
  return value.requests.every((request) => {
    if (
      !isStoredRequest(request, config)
      || localIds.has(request.localId)
      || (request.requestId !== null && requestIds.has(request.requestId))
    ) {
      return false;
    }
    localIds.add(request.localId);
    if (request.requestId !== null) requestIds.add(request.requestId);
    return true;
  });
}

function isStoredRequest(value: unknown, config: AppConfig): value is StoredRequest {
  if (!isRecord(value)) return false;
  if (
    typeof value.localId !== "string"
    || value.localId.length === 0
    || value.localId.length > 128
    || !isRequestStatus(value.status)
    || (value.phase !== "approval" && value.phase !== "swap")
    || !isPositiveIntegerAtMost(value.amountIn, I128_MAX)
    || !isPositiveIntegerAtMost(value.amountOutMin, U128_MAX)
    || !isNullableHash(value.transactionHash)
    || !(value.receiptBlock === null || isUnsignedInteger(value.receiptBlock))
    || !isNullableHash(value.requestId)
    || !isObservationTime(value.visibleObservationMs)
    || !isObservationBaseline(value.observationBaseline)
    || !isCriteria(value.criteria, config)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || !(value.observedThroughBlock === undefined
      || value.observedThroughBlock === null
      || isUnsignedInteger(value.observedThroughBlock))
    || !(value.snapshotInferenceEligible === undefined
      || typeof value.snapshotInferenceEligible === "boolean")
    || (value.snapshotInferenceEligible === true
      && value.observationBaseline === null)
    || !isExecution(value.execution)
  ) return false;

  const hasHash = value.transactionHash !== null;
  const hasReceipt = value.receiptBlock !== null;
  const hasRequestId = value.requestId !== null;
  if (
    value.observedThroughBlock != null
    && (value.receiptBlock === null
      || BigInt(value.observedThroughBlock) < BigInt(value.receiptBlock))
  ) return false;
  if (
    value.execution !== null
    && (value.receiptBlock === null
      || BigInt(value.execution.blockHeight) < BigInt(value.receiptBlock))
  ) return false;
  switch (value.status) {
    case "approving":
      return value.phase === "approval" && !hasReceipt && !hasRequestId
        && value.execution === null;
    case "submitting":
      return value.phase === "swap" && !hasReceipt && !hasRequestId
        && value.execution === null;
    case "indeterminate":
      return !hasReceipt && !hasRequestId && value.execution === null;
    case "committedFailure":
      return hasHash && !hasReceipt && !hasRequestId && value.execution === null;
    case "queued":
    case "queuedNotObserved":
      return value.phase === "swap" && hasHash && hasReceipt && hasRequestId
        && value.execution === null;
    case "queuedUntracked":
      return value.phase === "swap" && hasHash && hasReceipt && !hasRequestId
        && value.execution === null;
    case "executed":
      return value.phase === "swap" && hasHash && hasReceipt && hasRequestId
        && value.execution?.kind === "executed"
        && value.execution.amountIn === value.amountIn
        && BigInt(value.execution.amountOut) >= BigInt(value.amountOutMin);
    case "failed":
      return value.phase === "swap" && hasHash && hasReceipt && hasRequestId
        && value.execution?.kind === "failed";
  }
}

function isExecution(value: unknown): value is StoredRequest["execution"] {
  if (value === null) return true;
  if (!isRecord(value) || !HASH_PATTERN.test(String(value.transactionHash))) {
    return false;
  }
  if (!isUnsignedInteger(value.blockHeight)) return false;
  if (value.kind === "failed") {
    return Object.keys(value).every((key) =>
      ["kind", "transactionHash", "blockHeight"].includes(key)
    );
  }
  return value.kind === "executed"
    && isUnsignedInteger(value.amountIn)
    && isUnsignedInteger(value.amountOut)
    && BigInt(value.amountIn) > 0n
    && BigInt(value.amountOut) > 0n;
}

function isObservationBaseline(
  value: unknown,
): value is StoredRequest["observationBaseline"] {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return [
    "chainHeight",
    "inputBalance",
    "outputBalance",
    "inputAllowance",
    "reserveIn",
    "reserveOut",
  ].every((key) => isUnsignedInteger(value[key]));
}

function isCriteria(
  value: unknown,
  config: AppConfig,
): value is RequestRecord["criteria"] {
  if (!isRecord(value)) return false;
  if (
    !["pairAddress", "handlerAddress", "driverAddress", "recipient", "tokenIn", "tokenOut"]
      .every((key) => HASH_PATTERN.test(String(value[key])))
  ) return false;

  const tokenA = toHex0x(config.tokenAAddress);
  const tokenB = toHex0x(config.tokenBAddress);
  return value.pairAddress === toHex0x(config.pairAddress)
    && value.handlerAddress === toHex0x(config.handlerAddress)
    && value.driverAddress === toHex0x(config.driverAddress)
    && value.recipient === toHex0x(config.accountAddress)
    && ((value.tokenIn === tokenA && value.tokenOut === tokenB)
      || (value.tokenIn === tokenB && value.tokenOut === tokenA));
}

function isRequestStatus(value: unknown): value is RequestStatus {
  return [
    "approving",
    "submitting",
    "indeterminate",
    "committedFailure",
    "queued",
    "queuedNotObserved",
    "queuedUntracked",
    "executed",
    "failed",
  ].includes(String(value));
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && HASH_PATTERN.test(value));
}

function isUnsignedInteger(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isPositiveIntegerAtMost(value: unknown, maximum: bigint): value is string {
  return isUnsignedInteger(value) && BigInt(value) > 0n && BigInt(value) <= maximum;
}

function isObservationTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= 120_000;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
