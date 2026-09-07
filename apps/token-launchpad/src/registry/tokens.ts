import { addressFromHex, type GroundhogClient } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import { ERC20 } from "@/contracts/generated/standard-token";
import {
  safeDisplayDecimals,
  type CreatedToken,
} from "@/contracts/launchpad-client";
import type { RegistryToken } from "@/registry/client";

type BalanceReader = (
  client: GroundhogClient,
  config: AppConfig,
  token: CreatedToken,
) => Promise<bigint>;

export function registryTokenToCreatedToken(
  token: RegistryToken,
): CreatedToken {
  const decimals =
    token.decimals === null
      ? null
      : safeDisplayDecimals(BigInt(token.decimals));
  return {
    addressHex: token.tokenAddress,
    name: token.name ?? "Unnamed token",
    symbol: token.symbol ?? "TOKEN",
    decimals,
    initialSupply: BigInt(token.initialSupply),
    balance: null,
    balanceLoading: true,
    administratorHex: token.administratorAddress,
    holderHex: token.initialHolderAddress,
    block: BigInt(token.blockHeight),
    transactionHash: token.transactionHash,
    readError: token.decimals !== null && decimals === null,
  };
}

export async function enrichTokenBalances(
  client: GroundhogClient,
  config: AppConfig,
  tokens: readonly CreatedToken[],
  signal?: AbortSignal,
  readBalance: BalanceReader = defaultBalanceReader,
): Promise<CreatedToken[]> {
  const enriched: CreatedToken[] = [];
  for (let offset = 0; offset < tokens.length; offset += 10) {
    throwIfAborted(signal);
    enriched.push(
      ...(await Promise.all(
        tokens.slice(offset, offset + 10).map(async (token) => {
          try {
            const balance = await readBalance(client, config, token);
            throwIfAborted(signal);
            return { ...token, balance, balanceLoading: false };
          } catch (error) {
            if (signal?.aborted) throw error;
            return {
              ...token,
              balance: null,
              balanceLoading: false,
              readError: true,
            };
          }
        }),
      )),
    );
  }
  return enriched;
}

async function defaultBalanceReader(
  client: GroundhogClient,
  config: AppConfig,
  token: CreatedToken,
): Promise<bigint> {
  return (
    await ERC20.getBalanceOf.view({
      client,
      contract: addressFromHex(token.addressHex),
      caller: config.accountAddress,
      args: { addr: config.accountAddress },
    })
  ).value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}
