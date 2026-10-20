import {
  addressFromBase58,
  fixedFromBase58,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";

const DECIMAL = /^(?:0|[1-9]\d*)$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function canonicalHash(value: string, name: string): string {
  if (!isCanonical(value, hashFromBase58)) {
    throw new ValidationError(`${name} must be a 32-byte base58 hash`);
  }
  return value;
}

export function canonicalNetworkId(value: string, name: string): string {
  return canonicalHash(value, name);
}

export function canonicalAddress(value: string, name: string): string {
  if (!isCanonical(value, addressFromBase58)) {
    throw new ValidationError(`${name} must be a 32-byte base58 address`);
  }
  return value;
}

export function isBase58Identifier(value: unknown): boolean {
  return (
    typeof value === "string" &&
    isCanonical(value, (text) => fixedFromBase58(text, 32))
  );
}

// Base58 is case-sensitive; accept only the exact encoding the chain emits.
function isCanonical(value: string, decode: (text: string) => Uint8Array) {
  try {
    return toBase58(decode(value)) === value;
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

export function compareDecimal(left: string, right: string): number {
  return left.length === right.length
    ? left.localeCompare(right)
    : left.length - right.length;
}
