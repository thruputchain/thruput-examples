import { useState } from "react";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import { useWallet } from "@thruputchain/react";
import { Navigate, Route, Routes } from "react-router-dom";
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
  const wallet = useWallet();
  const readOnly = wallet.status !== "connected";
  // The launch's account survives a disconnect, so a reload can still observe
  // its saved transaction. It never grants authorization.
  const [workflowConfig, setWorkflowConfig] = useState(config);
  if (
    !readOnly &&
    wallet.address &&
    toBase58(workflowConfig.accountAddress) !== wallet.address
  ) {
    setWorkflowConfig({
      ...config,
      accountAddress: addressFromBase58(wallet.address),
    });
  }
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
              key={toBase58(workflowConfig.accountAddress)}
              config={workflowConfig}
              connected={!readOnly}
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
