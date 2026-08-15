import { toHex0x } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import type { SwapIntent } from "@/workflow";

export interface OutstandingRequest {
  status:
    | "approving"
    | "submitting"
    | "indeterminate"
    | "committedFailure"
    | "queued"
    | "queuedNotObserved"
    | "queuedUntracked";
  phase: "approval" | "swap";
  intent: SwapIntent;
  transactionHash: string | null;
  receiptBlock: bigint | null;
  requestId: string | null;
  visibleObservationMs: number;
  observationBaseline: {
    chainHeight: bigint;
    inputBalance: bigint;
    outputBalance: bigint;
    inputAllowance: bigint;
    reserveIn: bigint;
    reserveOut: bigint;
  } | null;
  criteria: {
    pairAddress: string;
    handlerAddress: string;
    driverAddress: string;
    recipient: string;
    tokenIn: string;
    tokenOut: string;
  };
}

export function outstandingRequestKey(config: AppConfig): string {
  return [
    "groundhog-swap:outstanding:v1",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    toHex0x(config.pairAddress),
  ].join(":");
}

export function loadOutstandingRequest(
  config: AppConfig,
): OutstandingRequest | null {
  if (typeof window === "undefined") return null;
  const key = outstandingRequestKey(config);
  const stored = window.localStorage.getItem(key);
  if (stored === null) return null;

  try {
    const value: unknown = JSON.parse(stored);
    if (
      !isStoredRequest(value) ||
      !criteriaMatchesConfig(value.criteria, config)
    ) {
      throw new Error("invalid outstanding request");
    }
    return {
      status: value.status === "queued" && value.requestId == null
        ? "queuedUntracked"
        : value.status,
      phase: value.phase,
      intent: {
        amountIn: BigInt(value.amountIn),
        amountOutMin: BigInt(value.amountOutMin),
      },
      transactionHash: value.transactionHash,
      receiptBlock:
        value.receiptBlock === null ? null : BigInt(value.receiptBlock),
      requestId: value.requestId ?? null,
      visibleObservationMs: value.visibleObservationMs ?? 0,
      observationBaseline: value.observationBaseline === undefined
        || value.observationBaseline === null
        ? null
        : {
            chainHeight: BigInt(value.observationBaseline.chainHeight),
            inputBalance: BigInt(value.observationBaseline.inputBalance),
            outputBalance: BigInt(value.observationBaseline.outputBalance),
            inputAllowance: BigInt(value.observationBaseline.inputAllowance),
            reserveIn: BigInt(value.observationBaseline.reserveIn),
            reserveOut: BigInt(value.observationBaseline.reserveOut),
          },
      criteria: {
        ...value.criteria,
        driverAddress:
          value.criteria.driverAddress ?? toHex0x(config.driverAddress),
      },
    };
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

export function saveOutstandingRequest(
  config: AppConfig,
  request: OutstandingRequest,
): void {
  window.localStorage.setItem(
    outstandingRequestKey(config),
    JSON.stringify({
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
        : Object.fromEntries(
            Object.entries(request.observationBaseline).map(([key, value]) => [
              key,
              value.toString(),
            ]),
          ),
      criteria: request.criteria,
    }),
  );
}

export function clearOutstandingRequest(config: AppConfig): void {
  window.localStorage.removeItem(outstandingRequestKey(config));
}

export async function withOutstandingRequestLock<T>(
  config: AppConfig,
  action: () => Promise<T>,
): Promise<T> {
  if (typeof window === "undefined" || window.navigator.locks === undefined) {
    throw new Error("This browser must support Web Locks for safe local signing");
  }
  return window.navigator.locks.request(
    requestLockName(config),
    { mode: "exclusive" },
    action,
  );
}

function requestLockName(config: AppConfig): string {
  return `${outstandingRequestKey(config)}:lock`;
}

function isStoredRequest(value: unknown): value is {
  status: OutstandingRequest["status"];
  phase: OutstandingRequest["phase"];
  amountIn: string;
  amountOutMin: string;
  transactionHash: string | null;
  receiptBlock: string | null;
  requestId?: string | null;
  visibleObservationMs?: number;
  observationBaseline?: {
    chainHeight: string;
    inputBalance: string;
    outputBalance: string;
    inputAllowance: string;
    reserveIn: string;
    reserveOut: string;
  } | null;
  criteria: Omit<OutstandingRequest["criteria"], "driverAddress"> & {
    driverAddress?: string;
  };
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    !(
      [
        "approving",
        "submitting",
        "indeterminate",
        "committedFailure",
        "queued",
        "queuedNotObserved",
        "queuedUntracked",
      ].includes(String(record.status)) &&
      (record.phase === "approval" || record.phase === "swap") &&
      typeof record.amountIn === "string" &&
      /^\d+$/.test(record.amountIn) &&
      typeof record.amountOutMin === "string" &&
      /^\d+$/.test(record.amountOutMin) &&
      (record.transactionHash === null ||
        (typeof record.transactionHash === "string" &&
          /^0x[0-9a-f]{64}$/.test(record.transactionHash))) &&
      (record.receiptBlock === null ||
        (typeof record.receiptBlock === "string" &&
          /^\d+$/.test(record.receiptBlock))) &&
      (record.requestId === undefined ||
        record.requestId === null ||
        (typeof record.requestId === "string" &&
          /^0x[0-9a-f]{64}$/.test(record.requestId))) &&
      (record.visibleObservationMs === undefined ||
        (typeof record.visibleObservationMs === "number" &&
          Number.isFinite(record.visibleObservationMs) &&
          record.visibleObservationMs >= 0 &&
          record.visibleObservationMs <= 120_000)) &&
      isObservationBaseline(record.observationBaseline) &&
      isCriteria(record.criteria)
    )
  )
    return false;

  const hasHash = record.transactionHash !== null;
  const hasReceipt = record.receiptBlock !== null;
  const hasRequestId = typeof record.requestId === "string";
  const phase = record.phase;
  switch (record.status) {
    case "approving":
      return phase === "approval" && !hasReceipt && !hasRequestId;
    case "submitting":
      return phase === "swap" && !hasReceipt && !hasRequestId;
    case "indeterminate":
      return !hasReceipt && !hasRequestId;
    case "committedFailure":
      return hasHash && !hasReceipt && !hasRequestId;
    case "queued":
      // Request IDs were not persisted by the first release. Keep migrating
      // those otherwise-valid records to queuedUntracked.
      return phase === "swap" && hasHash && hasReceipt;
    case "queuedNotObserved":
      return phase === "swap" && hasHash && hasReceipt && hasRequestId;
    case "queuedUntracked":
      return phase === "swap" && hasHash && hasReceipt && !hasRequestId;
    default:
      return false;
  }
}

function isObservationBaseline(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    "chainHeight",
    "inputBalance",
    "outputBalance",
    "inputAllowance",
    "reserveIn",
    "reserveOut",
  ].every((key) => typeof record[key] === "string" && /^\d+$/.test(record[key]));
}

function isCriteria(value: unknown): value is Omit<
  OutstandingRequest["criteria"],
  "driverAddress"
> & { driverAddress?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ["pairAddress", "handlerAddress", "recipient", "tokenIn", "tokenOut"].every(
    (key) => typeof record[key] === "string" && /^0x[0-9a-f]{64}$/.test(record[key]),
  ) && (record.driverAddress === undefined
    || (typeof record.driverAddress === "string"
      && /^0x[0-9a-f]{64}$/.test(record.driverAddress)));
}

function criteriaMatchesConfig(
  criteria: Omit<OutstandingRequest["criteria"], "driverAddress"> & {
    driverAddress?: string;
  },
  config: AppConfig,
): boolean {
  const tokenA = toHex0x(config.tokenAAddress);
  const tokenB = toHex0x(config.tokenBAddress);
  return (
    criteria.pairAddress === toHex0x(config.pairAddress)
    && criteria.handlerAddress === toHex0x(config.handlerAddress)
    && (criteria.driverAddress === undefined
      || criteria.driverAddress === toHex0x(config.driverAddress))
    && criteria.recipient === toHex0x(config.accountAddress)
    && ((criteria.tokenIn === tokenA && criteria.tokenOut === tokenB)
      || (criteria.tokenIn === tokenB && criteria.tokenOut === tokenA))
  );
}
