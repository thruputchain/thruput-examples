import { useMemo } from "react";
import { useClient, useWalletClient } from "@groundhogchain/react";
import type { GlobalConfig } from "@/config";
import { createProviderWriteBoundary } from "./provider-wallet";

export function useTransactions(config: GlobalConfig) {
  const client = useClient();
  const wallet = useWalletClient();
  return useMemo(
    () => createProviderWriteBoundary(config, client, wallet ?? undefined),
    [config, client, wallet],
  );
}
