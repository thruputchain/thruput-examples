export function abbreviateAddress(address: Uint8Array): string {
  const hex = Array.from(address, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `0x${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
