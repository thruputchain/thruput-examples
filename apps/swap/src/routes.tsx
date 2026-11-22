import { Navigate, Route, Routes } from "react-router-dom";
import { useWallet } from "@thruputchain/react";
import type { AppConfig } from "@/config";
import { CreatePoolPage } from "@/pools/create-pool-page";
import { PoolListPage } from "@/pools/pool-list-page";
import { PoolPage } from "@/pools/pool-page";

export function AppRoutes({ config }: { config: AppConfig }) {
  const wallet = useWallet();
  const connected = wallet.status === "connected";
  // Each account has its own saved requests, so remount on account changes.
  const account = wallet.address ?? "read-only";
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/pools" replace />} />
      <Route path="/pools" element={<PoolListPage config={config} />} />
      <Route
        path="/pools/new"
        element={
          connected ? (
            <CreatePoolPage key={account} config={config} />
          ) : (
            <ConnectPrompt />
          )
        }
      />
      <Route
        path="/pools/:token0/:token1"
        element={<PoolPage key={account} config={config} />}
      />
      <Route path="*" element={<Navigate to="/pools" replace />} />
    </Routes>
  );
}

function ConnectPrompt() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="app-page-title">Connect your wallet</h1>
      <p className="mt-2 text-muted-foreground">
        Connect a wallet above to create this pool. Your token selection is
        kept in the link.
      </p>
    </main>
  );
}
