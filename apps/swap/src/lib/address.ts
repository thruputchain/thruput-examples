import { fixedFromBase58, parseAddress, toBase58 } from "@thruputchain/client";

export function abbreviateIdentifier(value: string): string {
  return value.length <= 14
    ? value
    : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/** True for the exact base58 encoding of a 32-byte address or hash. */
export function isBase58Identifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return toBase58(fixedFromBase58(value, 32)) === value;
  } catch {
    return false;
  }
}

/**
 * Read a typed or pasted contract address (base58 or C StrKey) as canonical
 * base58. Returns null for anything else, including 0x hex.
 */
export function typedAddress(value: string): string | null {
  const text = value.trim();
  if (text.startsWith("0x") || text.startsWith("0X")) return null;
  try {
    return toBase58(parseAddress(text));
  } catch {
    return null;
  }
}
