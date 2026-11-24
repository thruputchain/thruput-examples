import type { AppConfig } from "@/config";

/** A link to Swap's "Create pool" page with the new token filled in. */
export function createAmmPoolLink(
  swapAppUrl: AppConfig["swapAppUrl"],
  tokenAddress: string,
): string | null {
  if (!swapAppUrl) return null;
  const url = new URL("pools/new", `${swapAppUrl.replace(/\/$/, "")}/`);
  url.search = new URLSearchParams({ tokenA: tokenAddress }).toString();
  return url.href;
}
