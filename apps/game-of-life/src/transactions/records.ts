import type { AppConfig } from "@/config";

const VERSION = 1;
const HISTORY_LIMIT = 50;
const HEX32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export type RequestStatus =
  | "signing"
  | "indeterminate"
  | "invalid"
  | "failed"
  | "accepted"
  | "acceptedUntracked"
  | "advanced"
  | "completionUnknown";

export interface TickRequestRecord {
  readonly schemaVersion: 1;
  readonly localId: string;
  readonly requester: string;
  readonly status: RequestStatus;
  readonly transactionHash: string | null;
  readonly requestId: string | null;
  readonly receiptBlock: string | null;
  readonly submittedAt: string;
  readonly acceptedAt: string | null;
  readonly observedThroughBlock: string | null;
  readonly resultingGeneration: string | null;
  readonly resultingPopulation: string | null;
  readonly resultingStateDigest: string | null;
  readonly advancedTransactionHash: string | null;
  readonly diagnostic: string | null;
}

export type CrankStatus =
  | "signing"
  | "indeterminate"
  | "invalid"
  | "failed"
  | "noWork"
  | "advanced"
  | "incompatible";

export interface CrankRecord {
  readonly schemaVersion: 1;
  readonly localId: string;
  readonly submittedBy: string;
  readonly status: CrankStatus;
  readonly transactionHash: string | null;
  readonly submittedAt: string;
  readonly completedAt: string | null;
  readonly receiptBlock: string | null;
  readonly consumedRequestId: string | null;
  readonly resultingGeneration: string | null;
  readonly resultingPopulation: string | null;
  readonly resultingStateDigest: string | null;
  readonly diagnostic: string | null;
}

interface RequestEnvelope {
  readonly version: 1;
  readonly requests: readonly TickRequestRecord[];
}

interface CrankEnvelope {
  readonly version: 1;
  readonly cranks: readonly CrankRecord[];
}

export interface TransactionScope {
  readonly networkId: string;
  readonly expectedCaller: string;
  readonly contractAddress: string;
}

export class TransactionStorageError extends Error {
  constructor(readonly key: string) {
    super(`Stored transaction data is invalid at ${key}`);
    this.name = "TransactionStorageError";
  }
}

export function transactionScope(
  config: Pick<AppConfig, "networkId" | "contractAddress">,
  expectedCaller: string,
): TransactionScope {
  return {
    networkId: config.networkId,
    expectedCaller,
    contractAddress: config.contractAddress,
  };
}

export function requestStorageKey(scope: TransactionScope): string {
  return scopedKey("requests", scope);
}

export function crankStorageKey(scope: TransactionScope): string {
  return scopedKey("cranks", scope);
}

export function transactionLockName(scope: TransactionScope): string {
  return scopedKey("lock", scope);
}

export function isTransactionStorageKey(
  scope: TransactionScope,
  key: string | null,
): boolean {
  return (
    key === null ||
    key === requestStorageKey(scope) ||
    key === crankStorageKey(scope)
  );
}

export function loadRequests(scope: TransactionScope): TickRequestRecord[] {
  const key = requestStorageKey(scope);
  const value = localStorage.getItem(key);
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRequestEnvelope(parsed) ||
      parsed.requests.some(
        ({ requester }) => requester !== scope.expectedCaller,
      )
    )
      throw new Error();
    return parsed.requests.map((record) => ({ ...record }));
  } catch {
    throw new TransactionStorageError(key);
  }
}

export function loadCranks(scope: TransactionScope): CrankRecord[] {
  const key = crankStorageKey(scope);
  const value = localStorage.getItem(key);
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isCrankEnvelope(parsed) ||
      parsed.cranks.some(
        ({ submittedBy }) => submittedBy !== scope.expectedCaller,
      )
    )
      throw new Error();
    return parsed.cranks.map((record) => ({ ...record }));
  } catch {
    throw new TransactionStorageError(key);
  }
}

export function saveRequests(
  scope: TransactionScope,
  records: readonly TickRequestRecord[],
): TickRequestRecord[] {
  const requests = prune(records, requestTerminal);
  const envelope: RequestEnvelope = { version: VERSION, requests };
  if (
    !isRequestEnvelope(envelope) ||
    requests.some(({ requester }) => requester !== scope.expectedCaller)
  )
    throw new TransactionStorageError(requestStorageKey(scope));
  localStorage.setItem(requestStorageKey(scope), JSON.stringify(envelope));
  return requests;
}

export function saveCranks(
  scope: TransactionScope,
  records: readonly CrankRecord[],
): CrankRecord[] {
  const cranks = prune(records, crankTerminal);
  const envelope: CrankEnvelope = { version: VERSION, cranks };
  if (
    !isCrankEnvelope(envelope) ||
    cranks.some(({ submittedBy }) => submittedBy !== scope.expectedCaller)
  )
    throw new TransactionStorageError(crankStorageKey(scope));
  localStorage.setItem(crankStorageKey(scope), JSON.stringify(envelope));
  return cranks;
}

export async function withTransactionLock<T>(
  scope: TransactionScope,
  action: () => Promise<T>,
): Promise<T> {
  if (navigator.locks === undefined)
    throw new Error(
      "This browser must support Web Locks for safe local signing",
    );
  return navigator.locks.request(
    transactionLockName(scope),
    { mode: "exclusive" },
    action,
  );
}

export function upsert<T extends { readonly localId: string }>(
  records: readonly T[],
  record: T,
): T[] {
  const index = records.findIndex(({ localId }) => localId === record.localId);
  return index === -1
    ? [...records, record]
    : records.map((current, offset) => (offset === index ? record : current));
}

export function hasBlockingCrank(records: readonly CrankRecord[]): boolean {
  return records.some(
    ({ status }) => status === "signing" || status === "indeterminate",
  );
}

function scopedKey(kind: string, scope: TransactionScope): string {
  return [
    `groundhog-life:${kind}:v1`,
    scope.networkId,
    scope.expectedCaller,
    scope.contractAddress,
  ].join(":");
}

function prune<T extends { readonly submittedAt: string }>(
  records: readonly T[],
  terminal: (record: T) => boolean,
): T[] {
  const terminalRecords = records.filter(terminal);
  if (terminalRecords.length <= HISTORY_LIMIT) return [...records];
  const remove = new Set(
    [...terminalRecords]
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
      .slice(0, terminalRecords.length - HISTORY_LIMIT),
  );
  return records.filter((record) => !remove.has(record));
}

function requestTerminal(record: TickRequestRecord): boolean {
  return ["invalid", "failed", "advanced", "completionUnknown"].includes(
    record.status,
  );
}

function crankTerminal(record: CrankRecord): boolean {
  return !["signing", "indeterminate"].includes(record.status);
}

function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  return (
    isRecord(value) &&
    value.version === VERSION &&
    Array.isArray(value.requests) &&
    value.requests.every(isRequest)
  );
}

function isCrankEnvelope(value: unknown): value is CrankEnvelope {
  return (
    isRecord(value) &&
    value.version === VERSION &&
    Array.isArray(value.cranks) &&
    value.cranks.every(isCrank)
  );
}

function isRequest(value: unknown): value is TickRequestRecord {
  if (!isRecord(value)) return false;
  const status = value.status;
  return (
    value.schemaVersion === VERSION &&
    validId(value.localId) &&
    hex(value.requester) &&
    typeof status === "string" &&
    [
      "signing",
      "indeterminate",
      "invalid",
      "failed",
      "accepted",
      "acceptedUntracked",
      "advanced",
      "completionUnknown",
    ].includes(status) &&
    nullableHex(value.transactionHash) &&
    nullableHex(value.requestId) &&
    nullableDecimal(value.receiptBlock) &&
    date(value.submittedAt) &&
    nullableDate(value.acceptedAt) &&
    nullableDecimal(value.observedThroughBlock) &&
    nullableDecimal(value.resultingGeneration) &&
    nullableDecimal(value.resultingPopulation) &&
    nullableHex(value.resultingStateDigest) &&
    nullableHex(value.advancedTransactionHash) &&
    nullableString(value.diagnostic) &&
    requestInvariant(value as unknown as TickRequestRecord)
  );
}

function requestInvariant(value: TickRequestRecord): boolean {
  const admission =
    value.transactionHash !== null &&
    value.requestId !== null &&
    value.receiptBlock !== null &&
    value.acceptedAt !== null;
  const noResult =
    value.resultingGeneration === null &&
    value.resultingPopulation === null &&
    value.resultingStateDigest === null &&
    value.advancedTransactionHash === null;
  const watermarkValid =
    value.observedThroughBlock === null ||
    value.receiptBlock === null ||
    BigInt(value.observedThroughBlock) >= BigInt(value.receiptBlock);
  switch (value.status) {
    case "signing":
      return (
        value.requestId === null &&
        value.receiptBlock === null &&
        value.acceptedAt === null &&
        value.observedThroughBlock === null &&
        noResult
      );
    case "indeterminate":
      return (
        value.transactionHash !== null &&
        value.requestId === null &&
        value.receiptBlock === null &&
        value.acceptedAt === null &&
        noResult
      );
    case "invalid":
    case "failed":
      return value.requestId === null && value.acceptedAt === null && noResult;
    case "accepted":
      return admission && noResult && watermarkValid;
    case "acceptedUntracked":
      return (
        value.transactionHash !== null &&
        value.receiptBlock !== null &&
        value.acceptedAt !== null &&
        value.requestId === null &&
        noResult
      );
    case "advanced":
      return (
        admission &&
        value.resultingGeneration !== null &&
        value.resultingPopulation !== null &&
        value.resultingStateDigest !== null &&
        value.advancedTransactionHash !== null &&
        watermarkValid
      );
    case "completionUnknown":
      return admission && noResult && watermarkValid;
  }
}

function isCrank(value: unknown): value is CrankRecord {
  if (!isRecord(value)) return false;
  const status = value.status;
  return (
    value.schemaVersion === VERSION &&
    validId(value.localId) &&
    hex(value.submittedBy) &&
    typeof status === "string" &&
    [
      "signing",
      "indeterminate",
      "invalid",
      "failed",
      "noWork",
      "advanced",
      "incompatible",
    ].includes(status) &&
    nullableHex(value.transactionHash) &&
    date(value.submittedAt) &&
    nullableDate(value.completedAt) &&
    nullableDecimal(value.receiptBlock) &&
    nullableHex(value.consumedRequestId) &&
    nullableDecimal(value.resultingGeneration) &&
    nullableDecimal(value.resultingPopulation) &&
    nullableHex(value.resultingStateDigest) &&
    nullableString(value.diagnostic) &&
    crankInvariant(value as unknown as CrankRecord)
  );
}

function crankInvariant(value: CrankRecord): boolean {
  const noResult =
    value.consumedRequestId === null &&
    value.resultingGeneration === null &&
    value.resultingPopulation === null &&
    value.resultingStateDigest === null;
  switch (value.status) {
    case "signing":
      return (
        value.completedAt === null && value.receiptBlock === null && noResult
      );
    case "indeterminate":
      return (
        value.transactionHash !== null &&
        value.completedAt === null &&
        value.receiptBlock === null &&
        noResult
      );
    case "invalid":
    case "failed":
      return value.completedAt !== null && noResult;
    case "noWork":
      return (
        value.transactionHash !== null &&
        value.completedAt !== null &&
        value.receiptBlock !== null &&
        noResult
      );
    case "advanced":
      return (
        value.transactionHash !== null &&
        value.completedAt !== null &&
        value.receiptBlock !== null &&
        value.consumedRequestId !== null &&
        value.resultingGeneration !== null &&
        value.resultingPopulation !== null &&
        value.resultingStateDigest !== null
      );
    case "incompatible":
      return (
        value.transactionHash !== null &&
        value.completedAt !== null &&
        value.receiptBlock !== null &&
        noResult
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function hex(value: unknown): value is string {
  return typeof value === "string" && HEX32.test(value);
}
function nullableHex(value: unknown): value is string | null {
  return value === null || hex(value);
}
function nullableDecimal(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DECIMAL.test(value));
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function nullableDate(value: unknown): value is string | null {
  return value === null || date(value);
}
function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 1_000);
}
