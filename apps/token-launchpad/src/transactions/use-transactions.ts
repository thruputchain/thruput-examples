import { useMemo } from "react";
import { toHex0x } from "@groundhogchain/client";
import {
  transactionReceiptQueryOptions,
  useClient,
  useWalletClient,
} from "@groundhogchain/react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppConfig } from "@/config";
import { createProviderWriteBoundary } from "./provider-wallet";
import { createTransactionObserver } from "./transaction-observation";

export function useTransactions(config: AppConfig) {
  const client = useClient();
  const wallet = useWalletClient();
  const queries = useQueryClient();
  return useMemo(
    () => ({
      ...createProviderWriteBoundary(config, client, wallet ?? undefined),
      observe: createTransactionObserver(config, {
        waitForTransactionReceipt: (hash) => {
          if (
            toHex0x(client.network.networkHash) !== `0x${config.networkIdHex}`
          )
            throw new Error("The saved transaction belongs to another network");
          return queries.fetchQuery(
            transactionReceiptQueryOptions({
              client,
              hash: toHex0x(hash),
              wait: { timeoutMs: 20_000, pollingIntervalMs: 500 },
            }),
          );
        },
      }),
    }),
    [config, client, wallet, queries],
  );
}
