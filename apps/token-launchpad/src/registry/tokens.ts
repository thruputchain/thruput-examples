import {
  safeDisplayDecimals,
  type CreatedToken,
} from "@/contracts/launchpad-client";
import type { RegistryToken } from "@/registry/client";

export function registryTokenToCreatedToken(
  token: RegistryToken,
): CreatedToken {
  return {
    addressHex: token.tokenAddress,
    name: token.name ?? "Unnamed token",
    symbol: token.symbol ?? "TOKEN",
    decimals:
      token.decimals === null
        ? null
        : safeDisplayDecimals(BigInt(token.decimals)),
    initialSupply: BigInt(token.initialSupply),
    administratorHex: token.administratorAddress,
    holderHex: token.initialHolderAddress,
    block: BigInt(token.blockHeight),
    transactionHash: token.transactionHash,
  };
}
