import type { GroundhogClient } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import { ERC20, ERC20Metadata } from "@/contracts/generated/standard-token";
import {
  readCreatedTokens,
  safeDisplayDecimals,
} from "@/contracts/launchpad-client";

export interface WalletPortfolio {
  hogBalance: bigint | null;
  hogDecimals: number | null;
  tokens: Array<{
    addressHex: string;
    symbol: string;
    decimals: number | null;
    balance: bigint | null;
  }>;
  partial: boolean;
}

export type WalletPortfolioReader = () => Promise<WalletPortfolio>;

export function createWalletPortfolioReader(
  client: GroundhogClient,
  config: AppConfig,
  readTokens = readCreatedTokens,
): WalletPortfolioReader {
  let pending: Promise<WalletPortfolio> | null = null;
  return async () => {
    if (pending) return pending;
    pending = (async () => {
      const [hog, created] = await Promise.allSettled([
        Promise.all([
          ERC20.getBalanceOf.view({
            client,
            contract: config.nativeHogAddress,
            caller: config.accountAddress,
            args: { addr: config.accountAddress },
          }),
          ERC20Metadata.decimals.view({
            client,
            contract: config.nativeHogAddress,
            caller: config.accountAddress,
          }),
        ]),
        readTokens(client, config, { creator: null }),
      ]);
      const tokens =
        created.status === "fulfilled"
          ? created.value.tokens.flatMap(
              ({ addressHex, symbol, decimals, balance }) =>
                balance !== null && balance > 0n
                  ? [{ addressHex, symbol, decimals, balance }]
                  : [],
            )
          : [];
      const hogDecimals =
        hog.status === "fulfilled"
          ? safeDisplayDecimals(hog.value[1].value)
          : null;
      return {
        hogBalance: hog.status === "fulfilled" ? hog.value[0].value : null,
        hogDecimals,
        tokens,
        partial:
          hog.status === "rejected" ||
          hogDecimals === null ||
          created.status === "rejected" ||
          (created.status === "fulfilled" &&
            (created.value.truncated ||
              created.value.historyLimited ||
              created.value.tokens.some(({ balance }) => balance === null))),
      };
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}
