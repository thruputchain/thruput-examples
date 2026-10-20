import { safeDisplayDecimals } from "@/contracts/launchpad-client";
import type { RegistryToken } from "@/registry/client";

export interface CreatedToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  initialSupply: bigint;
  administrator: string;
  holder: string;
  block: bigint;
  transactionHash: string;
}

export function registryTokenToCreatedToken(
  token: RegistryToken,
): CreatedToken {
  return {
    address: token.tokenAddress,
    name: token.name ?? "Unnamed token",
    symbol: token.symbol ?? "TOKEN",
    decimals:
      token.decimals === null
        ? null
        : safeDisplayDecimals(BigInt(token.decimals)),
    initialSupply: BigInt(token.initialSupply),
    administrator: token.administratorAddress,
    holder: token.initialHolderAddress,
    block: BigInt(token.blockHeight),
    transactionHash: token.transactionHash,
  };
}
