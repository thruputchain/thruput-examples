const NETWORK_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;

export function normalizeNetworkId(input: string): string {
  if (!NETWORK_PATTERN.test(input))
    throw new Error(
      "VITE_GROUNDHOG_NETWORK_ID must be a 32-byte hexadecimal value",
    );
  return input.replace(/^0x/i, "").toLowerCase();
}
