import { toHex0x } from "@groundhogchain/client";

import type { AppConfig } from "@/config";

const STORAGE_VERSION = 1;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export type CrankAttemptStatus =
  | "signing"
  | "indeterminate"
  | "committed"
  | "failed";

export interface CrankAttempt {
  id: string;
  status: CrankAttemptStatus;
  transactionHash: string | null;
  createdAt: number;
  updatedAt: number;
  driverAddress: string;
  message: string | null;
}

interface StoredCrankAttempt extends CrankAttempt {
  version: typeof STORAGE_VERSION;
}

export class CrankAttemptError extends Error {
  constructor() {
    super("Stored queue-processing state is invalid");
    this.name = "CrankAttemptError";
  }
}

export function crankAttemptKey(config: AppConfig): string {
  return [
    "groundhog-swap:crank:v3",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    toHex0x(config.factoryAddress),
    toHex0x(config.driverAddress),
  ].join(":");
}

function accountCrankAttemptPrefix(
  config: Pick<AppConfig, "networkIdHex" | "accountAddress">,
): string {
  return [
    "groundhog-swap:crank:v3",
    config.networkIdHex,
    toHex0x(config.accountAddress),
    "",
  ].join(":");
}

export function isAccountCrankAttemptKey(
  config: Pick<AppConfig, "networkIdHex" | "accountAddress">,
  key: string | null,
): boolean {
  if (key === null) return false;
  return key.startsWith(accountCrankAttemptPrefix(config));
}

export function loadAccountCrankAttempts(
  config: Pick<AppConfig, "networkIdHex" | "accountAddress">,
): CrankAttempt[] {
  if (typeof window === "undefined") return [];
  const attempts: CrankAttempt[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !isAccountCrankAttemptKey(config, key)) continue;
    const stored = window.localStorage.getItem(key);
    if (stored === null) continue;
    try {
      const parsed: unknown = JSON.parse(stored);
      if (!isStoredCrankAttempt(parsed)) throw new Error("invalid crank attempt");
      const { version: _version, ...attempt } = parsed;
      attempts.push(attempt);
    } catch {
      throw new CrankAttemptError();
    }
  }
  return attempts;
}

export function createCrankAttempt(
  config: AppConfig,
  now = Date.now(),
): CrankAttempt {
  return {
    id: crypto.randomUUID(),
    status: "signing",
    transactionHash: null,
    createdAt: now,
    updatedAt: now,
    driverAddress: toHex0x(config.driverAddress),
    message: null,
  };
}

export function loadCrankAttempt(config: AppConfig): CrankAttempt | null {
  if (typeof window === "undefined") return null;
  const key = crankAttemptKey(config);
  try {
    return parseCrankAttempt(window.localStorage.getItem(key), config);
  } catch {
    throw new CrankAttemptError();
  }
}

export function saveCrankAttempt(
  config: AppConfig,
  attempt: CrankAttempt,
): CrankAttempt {
  const stored: StoredCrankAttempt = {
    ...attempt,
    version: STORAGE_VERSION,
    driverAddress: toHex0x(config.driverAddress),
  };
  if (!isStoredCrankAttempt(stored, config)) throw new CrankAttemptError();
  window.localStorage.setItem(crankAttemptKey(config), JSON.stringify(stored));
  const { version: _version, ...saved } = stored;
  return saved;
}

export function isBlockingCrankAttempt(attempt: CrankAttempt | null): boolean {
  return attempt?.status === "signing" || attempt?.status === "indeterminate";
}

function isStoredCrankAttempt(
  value: unknown,
  config?: AppConfig,
): value is StoredCrankAttempt {
  if (typeof value !== "object" || value === null) return false;
  const attempt = value as Partial<StoredCrankAttempt>;
  if (
    attempt.version !== STORAGE_VERSION
    || typeof attempt.id !== "string"
    || attempt.id.length === 0
    || !isStatus(attempt.status)
    || (attempt.transactionHash !== null
      && (typeof attempt.transactionHash !== "string"
        || !HASH_PATTERN.test(attempt.transactionHash)))
    || !validTime(attempt.createdAt)
    || !validTime(attempt.updatedAt)
    || attempt.updatedAt! < attempt.createdAt!
    || !HASH_PATTERN.test(String(attempt.driverAddress))
    || (config !== undefined
      && attempt.driverAddress !== toHex0x(config.driverAddress))
    || (attempt.message !== null && typeof attempt.message !== "string")
  ) return false;
  return attempt.status !== "committed" || attempt.transactionHash !== null;
}

function parseCrankAttempt(
  value: string | null,
  config: AppConfig,
): CrankAttempt | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!isStoredCrankAttempt(parsed, config)) throw new Error("invalid crank attempt");
  const { version: _version, ...attempt } = parsed;
  return attempt;
}

function isStatus(value: unknown): value is CrankAttemptStatus {
  return value === "signing"
    || value === "indeterminate"
    || value === "committed"
    || value === "failed";
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
