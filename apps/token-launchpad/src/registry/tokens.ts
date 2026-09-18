import { safeDisplayDecimals } from "@/contracts/launchpad-client";
import type { RegistryToken } from "@/registry/client";

export interface CreatedToken {
  addressHex: string;
  name: string;
  symbol: string;
  decimals: number | null;
  initialSupply: bigint;
  administratorHex: string;
  holderHex: string;
  block: bigint;
  transactionHash: string;
}

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
