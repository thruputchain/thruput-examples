import { useMemo } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ExplorerProvider } from "@/components/blockchain-identifier";
import { AppHeader } from "@/components/app-header";
import { WalletControls } from "@/wallet/wallet-controls";
import { useWalletWriteBoundary } from "@/wallet/write-context";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import type { AppConfig } from "@/config";
import { createReadClient } from "@/groundhog/client";
import { CreatePage } from "@/launch/create-page";
import { TokensPage } from "@/tokens/tokens-page";
import { type WriteBoundary } from "@/transactions/write-boundary";

export function LaunchpadRoutes({
  config,
  writer: suppliedWriter,
  readOnly = true,
}: {
  config: AppConfig;
  writer?: WriteBoundary | undefined;
  readOnly?: boolean;
}) {
  const client = useMemo(() => createReadClient(config), [config]);
  const connectedWriter = useWalletWriteBoundary();
  const writer = suppliedWriter ?? connectedWriter;
  return (
    <ExplorerProvider explorerUrl={config.explorerUrl}>
      <Header readOnly={readOnly} />
      <Routes>
        <Route path="/" element={<Navigate to="/tokens" replace />} />
        <Route
          path="/create"
          element={
            readOnly ? (
              <ConnectPrompt />
            ) : (
              <CreatePage config={config} client={client} writer={writer} />
            )
          }
        />
        <Route
          path="/tokens"
          element={
            <TokensPage
              config={config}
              client={client}
              scope="all"
              readOnly={readOnly}
            />
          }
        />
        <Route
          path="/my-tokens"
          element={
            readOnly ? (
              <ConnectPrompt />
            ) : (
              <TokensPage config={config} client={client} scope="mine" />
            )
          }
        />
        <Route path="*" element={<Navigate to="/tokens" replace />} />
      </Routes>
    </ExplorerProvider>
  );
}

export function Header({ readOnly = false }: { readOnly?: boolean }) {
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
