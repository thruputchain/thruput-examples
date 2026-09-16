import { readFile } from "node:fs/promises";
import { canonicalAddress, type FaucetManifest } from "../src/domain.ts";

export async function readManifest(
  path: string,
  swapUrl?: string,
): Promise<FaucetManifest> {
  const value = JSON.parse(await readFile(path, "utf8")) as FaucetManifest;
  if (swapUrl !== undefined) value.swapUrl = swapUrl;
  if (
    value.version !== 1 ||
    !Array.isArray(value.tokens) ||
    value.tokens.length !== 5
  ) {
    throw new Error("Expected a faucet deployment with five tokens.");
  }
  for (const field of ["network", "account"] as const) {
    if (canonicalAddress(value[field]) !== value[field])
      throw new Error(`Invalid ${field} in faucet deployment.`);
  }
  for (const field of ["rpcUrl", "swapUrl", "explorerUrl"] as const) {
    const url = new URL(value[field]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error(`Invalid ${field} in faucet deployment.`);
    }
  }
  for (const token of value.tokens) {
    if (
      canonicalAddress(token.address) !== token.address ||
      !Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 18 ||
      typeof token.name !== "string" ||
      typeof token.symbol !== "string"
    ) {
      throw new Error("Invalid faucet token.");
    }
  }
  if (new Set(value.tokens.map((token) => token.address)).size !== 5)
    throw new Error("Duplicate faucet tokens.");
  return {
    version: value.version,
    network: value.network,
    rpcUrl: value.rpcUrl,
    account: value.account,
    swapUrl: value.swapUrl,
    explorerUrl: value.explorerUrl,
    tokens: value.tokens,
  };
}
