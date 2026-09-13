export function formatHog(raw: bigint, fractionDigits = 7): string {
  const fraction = (raw % 10_000_000n)
    .toString()
    .padStart(7, "0")
    .slice(0, fractionDigits)
    .replace(/0+$/, "");
  return `${raw / 10_000_000n}${fraction ? `.${fraction}` : ""}`;
}
