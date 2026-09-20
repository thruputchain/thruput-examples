import { useState } from "react";
import { addressFromHex, toHex0x } from "@groundhogchain/client";
import { useClient, getClientQueryKey, useWallet } from "@groundhogchain/react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { useTransactions } from "@/transactions/use-transactions";
import { workflowStorageKey } from "@/launch/workflow";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import type { AppConfig } from "@/config";
import { CreatePage } from "@/launch/create-page";
import { TokensPage } from "@/tokens/tokens-page";

export function AppRoutes({ config }: { config: AppConfig }) {
  const client = useClient();
  const queries = useQueryClient();
  const wallet = useWallet();
  const readOnly = wallet.status !== "connected";
  // Saved workflow identity survives disconnect; it never grants authorization.
  const [workflowConfig, setWorkflowConfig] = useState(config);
  if (
    !readOnly &&
    wallet.address &&
    toHex0x(workflowConfig.accountAddress) !== wallet.address
  ) {
    setWorkflowConfig({
      ...config,
      accountAddress: addressFromHex(wallet.address),
    });
  }
  const writer = useTransactions(workflowConfig);
  const hasWalletAccount = workflowConfig !== config;
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/tokens" replace />} />
      <Route
        path="/create"
        element={
          readOnly && !hasWalletAccount ? (
            <ConnectPrompt />
          ) : (
            <CreatePage
              key={workflowStorageKey(workflowConfig)}
              config={workflowConfig}
              client={client}
              writer={writer}
              connected={!readOnly}
              onCommitted={() => {
                void queries.invalidateQueries({
                  queryKey: getClientQueryKey(client),
                });
              }}
            />
          )
        }
      />
      <Route
        path="/tokens"
        element={<TokensPage config={config} scope="all" readOnly={readOnly} />}
      />
      <Route
        path="/my-tokens"
        element={
          readOnly ? (
            <ConnectPrompt />
          ) : (
            <TokensPage config={workflowConfig} scope="mine" />
          )
        }
      />
      <Route path="*" element={<Navigate to="/tokens" replace />} />
    </Routes>
  );
}

function ConnectPrompt() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Connect your wallet</EmptyTitle>
          <EmptyDescription>
            Connect a wallet above to create tokens or view your tokens. Public
            token browsing does not require a wallet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}
