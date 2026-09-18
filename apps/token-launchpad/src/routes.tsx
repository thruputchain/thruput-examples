import { useMemo, useState } from "react";
import { addressFromHex, toHex0x } from "@groundhogchain/client";
import {
  useClient,
  getClientQueryKey,
  useWallet,
  useWalletClient,
} from "@groundhogchain/react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ExplorerProvider } from "@/components/blockchain-identifier";
import { AppHeader } from "@/components/app-header";
import { WalletControls } from "@/wallet/wallet-controls";
import { createProviderWriteBoundary } from "@/transactions/provider-wallet";
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

export function LaunchpadRoutes({ config }: { config: AppConfig }) {
  const client = useClient();
  const queries = useQueryClient();
  const wallet = useWallet();
  const signingClient = useWalletClient();
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
  const writer = useMemo(
    () =>
      createProviderWriteBoundary(
        workflowConfig,
        client,
        signingClient ?? undefined,
      ),
    [workflowConfig, client, signingClient],
  );
  const hasWalletAccount = workflowConfig !== config;
  return (
    <ExplorerProvider explorerUrl={config.explorerUrl}>
      <Header readOnly={readOnly} />
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
          element={
            <TokensPage config={config} scope="all" readOnly={readOnly} />
          }
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
    </ExplorerProvider>
  );
}

function Header({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <AppHeader
      product="Token Launchpad"
      homeHref={readOnly ? "/tokens" : "/create"}
      navigation={
        <>
          <NavLink className="app-nav-link" to="/tokens">
            Tokens
          </NavLink>
          <NavLink className="app-nav-link" to="/my-tokens">
            My Tokens
          </NavLink>
          <NavLink className="app-nav-link" to="/create">
            Create Token
          </NavLink>
        </>
      }
      actions={<WalletControls />}
    />
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
