import { toBase58 } from "@thruputchain/client";

import type { GlobalConfig } from "@/config";
import { isBase58Identifier } from "@/lib/address";

// Version 3 stores addresses as base58.
const STORAGE_VERSION = 3;

interface AllowanceEvidenceEntry {
  tokenAddress: string;
  spenderAddress: string;
  terminalBlock: string;
}

interface StoredAllowanceEvidence {
  version: typeof STORAGE_VERSION;
  entries: AllowanceEvidenceEntry[];
}

type AllowanceEvidenceScope = Pick<GlobalConfig, "networkId" | "accountAddress">;

export function recordAllowanceTerminalEvidence(
  config: AllowanceEvidenceScope,
  tokenAddress: string,
  spenderAddress: string,
  terminalBlock: bigint,
): void {
  const stored = loadAllowanceEvidence(config);
  const existing = stored.entries.find((entry) =>
    entry.tokenAddress === tokenAddress && entry.spenderAddress === spenderAddress
  );
  const entries = existing === undefined
    ? [...stored.entries, {
        tokenAddress,
        spenderAddress,
        terminalBlock: terminalBlock.toString(),
      }]
    : stored.entries.map((entry) =>
        entry === existing && terminalBlock > BigInt(entry.terminalBlock)
          ? { ...entry, terminalBlock: terminalBlock.toString() }
          : entry
      );
  const next: StoredAllowanceEvidence = { version: STORAGE_VERSION, entries };
  if (!isStoredAllowanceEvidence(next)) {
    throw new Error("Allowance terminal evidence is invalid");
  }
  window.localStorage.setItem(allowanceEvidenceKey(config), JSON.stringify(next));
}

export function loadAllowanceTerminalHeight(
  config: AllowanceEvidenceScope,
  tokenAddress: string,
  spenderAddress: string,
): bigint {
  const entry = loadAllowanceEvidence(config).entries.find((candidate) =>
    candidate.tokenAddress === tokenAddress
    && candidate.spenderAddress === spenderAddress
  );
  return entry === undefined ? 0n : BigInt(entry.terminalBlock);
}

function allowanceEvidenceKey(config: AllowanceEvidenceScope): string {
  return [
    "groundhog-swap:allowance-evidence:v2",
    config.networkId,
    toBase58(config.accountAddress),
  ].join(":");
}

function loadAllowanceEvidence(
  config: AllowanceEvidenceScope,
): StoredAllowanceEvidence {
  if (typeof window === "undefined") {
    return { version: STORAGE_VERSION, entries: [] };
  }
  const raw = window.localStorage.getItem(allowanceEvidenceKey(config));
  if (raw === null) return { version: STORAGE_VERSION, entries: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredAllowanceEvidence(parsed)) throw new Error("invalid evidence");
    return parsed;
  } catch {
    throw new Error("Stored allowance terminal evidence is invalid");
  }
}

function isStoredAllowanceEvidence(
  value: unknown,
): value is StoredAllowanceEvidence {
  if (!isRecord(value) || value.version !== STORAGE_VERSION) return false;
  if (!Array.isArray(value.entries)) return false;
  const identities = new Set<string>();
  return value.entries.every((entry) => {
    if (!isRecord(entry)) return false;
    if (
      !isBase58Identifier(entry.tokenAddress)
      || !isBase58Identifier(entry.spenderAddress)
      || typeof entry.terminalBlock !== "string"
      || !/^(?:0|[1-9]\d*)$/.test(entry.terminalBlock)
    ) return false;
    const identity = `${entry.tokenAddress}:${entry.spenderAddress}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
