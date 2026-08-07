import { toHex0x } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import type { SwapIntent } from "@/workflow";

export interface OutstandingRequest {
  status:
    | "approving"
    | "submitting"
    | "indeterminate"
    | "committedFailure"
    | "queued";
  phase: "approval" | "swap";
  intent: SwapIntent;
  transactionHash: string | null;
  receiptBlock: bigint | null;
  criteria: {
    pairAddress: string;
    handlerAddress: string;
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
    if (!isStoredRequest(value)) throw new Error("invalid outstanding request");
    return {
      status: value.status,
      phase: value.phase,
      intent: {
        amountIn: BigInt(value.amountIn),
        amountOutMin: BigInt(value.amountOutMin),
      },
      transactionHash: value.transactionHash,
      receiptBlock:
        value.receiptBlock === null ? null : BigInt(value.receiptBlock),
      criteria: value.criteria,
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
    `${outstandingRequestKey(config)}:lock`,
    { mode: "exclusive" },
    action,
  );
}

function isStoredRequest(value: unknown): value is {
  status: OutstandingRequest["status"];
  phase: OutstandingRequest["phase"];
  amountIn: string;
  amountOutMin: string;
  transactionHash: string | null;
  receiptBlock: string | null;
  criteria: OutstandingRequest["criteria"];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    ["approving", "submitting", "indeterminate", "committedFailure", "queued"].includes(String(record.status))
    && (record.phase === "approval" || record.phase === "swap")
    && typeof record.amountIn === "string"
    && /^\d+$/.test(record.amountIn)
    && typeof record.amountOutMin === "string"
    && /^\d+$/.test(record.amountOutMin)
    && (record.transactionHash === null
      || (typeof record.transactionHash === "string"
        && /^0x[0-9a-f]{64}$/.test(record.transactionHash)))
    && (record.receiptBlock === null
      || (typeof record.receiptBlock === "string"
        && /^\d+$/.test(record.receiptBlock)))
    && isCriteria(record.criteria)
  );
}

function isCriteria(value: unknown): value is OutstandingRequest["criteria"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ["pairAddress", "handlerAddress", "recipient", "tokenIn", "tokenOut"].every(
    (key) => typeof record[key] === "string" && /^0x[0-9a-f]{64}$/.test(record[key]),
  );
}
