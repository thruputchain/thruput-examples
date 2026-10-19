import { fixedFromBase58, toBase58, toHex0x } from "@thruputchain/client";

const HASH = /^(?:0x)?[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function canonicalHash(value: string, name: string): string {
  if (!HASH.test(value)) {
    throw new ValidationError(`${name} must be a 32-byte hexadecimal value`);
  }
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

export function canonicalNetworkId(value: string, name: string): string {
  return canonicalHash(value, name).slice(2);
}

export function canonicalAddress(value: string, name: string): string {
  if (!ADDRESS.test(value)) {
    throw new ValidationError(`${name} must be a 32-byte 0x-prefixed address`);
  }
  return value.toLowerCase();
}

/** Read a canonical base58 32-byte identifier as the store's 0x hex form. */
export function base58Identifier(value: string, name: string): string {
  try {
    const bytes = fixedFromBase58(value, 32);
    if (toBase58(bytes) === value) return toHex0x(bytes);
  } catch {
    // Reported below.
  }
  throw new ValidationError(`${name} must be a base58 32-byte value`);
}

export function isBase58Identifier(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return toBase58(fixedFromBase58(value, 32)) === value;
  } catch {
    return false;
  }
}

export function canonicalDecimal(value: string, name: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new ValidationError(`${name} must be a canonical unsigned integer`);
  }
  return value;
}

export function boundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!DECIMAL.test(value)) {
    throw new ValidationError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

export function normalizedSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function compareDecimal(left: string, right: string): number {
  return left.length === right.length
    ? left.localeCompare(right)
    : left.length - right.length;
}
