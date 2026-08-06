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

  const scale = 10n ** BigInt(decimals);
  const paddedFraction = fraction.padEnd(decimals, "0");
  const value = BigInt(whole || "0") * scale + BigInt(paddedFraction || "0");
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

  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  if (maximumFractionDigits === 0) {
    return whole.toString();
  }

  const fullFraction = (value % scale).toString().padStart(decimals, "0");
  const fraction = fullFraction
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Token decimals must be an integer between 0 and 255");
  }
}
