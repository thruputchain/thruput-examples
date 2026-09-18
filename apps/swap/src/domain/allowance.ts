const I128_MIN = -(1n << 127n);
export const I128_MAX = (1n << 127n) - 1n;

export type AllowanceDifference =
  | { ok: true; difference: bigint }
  | { ok: false; error: "outOfRange" };

export function allowanceDifference(
  desiredAllowance: bigint,
  currentAllowance: bigint,
): AllowanceDifference {
  if (desiredAllowance < 0n || currentAllowance < 0n) {
    throw new RangeError("Allowances cannot be negative");
  }

  const difference = desiredAllowance - currentAllowance;
  if (difference < I128_MIN || difference > I128_MAX) {
    return { ok: false, error: "outOfRange" };
  }
  return { ok: true, difference };
}
