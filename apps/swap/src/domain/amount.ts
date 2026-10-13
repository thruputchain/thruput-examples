import { formatUnits, parseUnits } from "@thruputchain/client";

const DECIMAL_PATTERN = /^(?:\d+\.?\d*|\.\d+)$/;
export const U128_MAX = (1n << 128n) - 1n;

export type AmountParseError = "empty" | "malformed" | "precision" | "bounds";

export type AmountParseResult =
  | { ok: true; value: bigint }
  | { ok: false; error: AmountParseError };

export function parseAmount(input: string, decimals: number): AmountParseResult {
  assertDecimals(decimals);

  if (input.length === 0) {
    return { ok: false, error: "empty" };
  }
  if (!DECIMAL_PATTERN.test(input)) {
    return { ok: false, error: "malformed" };
  }

  const [whole = "0", fraction = ""] = input.split(".");
  if (fraction.length > decimals) {
    return { ok: false, error: "precision" };
  }

  // Keep the form's .5 and 1. shorthand; the SDK accepts canonical decimals.
  const value = parseUnits(
    `${whole || "0"}${fraction ? `.${fraction}` : ""}`,
    decimals,
  );
  if (value > U128_MAX) {
    return { ok: false, error: "bounds" };
  }
  return { ok: true, value };
}

export function formatAmount(
  value: bigint,
  decimals: number,
  maximumFractionDigits = decimals,
): string {
  assertDecimals(decimals);
  if (value < 0n) {
    throw new RangeError("Token amount cannot be negative");
  }
  if (
    !Number.isInteger(maximumFractionDigits) ||
    maximumFractionDigits < 0 ||
    maximumFractionDigits > decimals
  ) {
    throw new RangeError("Maximum fraction digits must be between zero and decimals");
  }

  const truncated = value / 10n ** BigInt(decimals - maximumFractionDigits);
  return formatUnits(truncated, maximumFractionDigits);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Token decimals must be an integer between 0 and 255");
  }
}
