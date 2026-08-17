export function abbreviateIdentifier(value: string): string {
  return value.length <= 14
    ? value
    : `${value.slice(0, 8)}…${value.slice(-4)}`;
}
