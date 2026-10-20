import { addressFromBase58 } from "@thruputchain/client";
import { useMemo, useState } from "react";
import { useWallet, useWalletClient } from "@thruputchain/react";
import { Navigate, Route, Routes } from "react-router-dom";
import { type GlobalConfig, READ_ONLY_CALLER } from "@/config";
import { PoolCreatePage } from "@/pools/pool-create-page";
import { PoolDirectoryPage } from "@/pools/pool-directory-page";
import {
  NotFoundPage,
  PlaceholderPage,
  PoolRoute,
  ReadOnlyPoolRedirect,
} from "@/pools/pool-route-view";

export function AppRoutes({ config: baseConfig }: { config: GlobalConfig }) {
  const wallet = useWallet();
  const binding = useWalletClient();
  const address = wallet.status === "connected" ? wallet.address : null;
  const config = useMemo(
    () => ({
      ...baseConfig,
      accountAddress: address ? addressFromBase58(address) : READ_ONLY_CALLER,
    }),
    [baseConfig, address],
  );
  const [scope, setScope] = useState({ binding, revision: 0 });
  if (scope.binding !== binding)
    setScope({ binding, revision: scope.revision + 1 });
  return (
    <PoolRoutes
      config={config}
      readOnly={wallet.status !== "connected"}
      writeRevision={scope.revision}
    />
  );
}

// Separate route selection from wallet binding so URL behavior can be tested directly.
export function PoolRoutes({
  config,
  readOnly = false,
  writeRevision = 0,
}: {
  config: GlobalConfig;
  readOnly?: boolean;
  writeRevision?: number;
}) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/pools" replace />} />
      <Route
        path="/pools"
        element={<PoolDirectoryPage config={config} readOnly={readOnly} />}
      />
      <Route
        path="/pools/new"
        element={
          readOnly ? (
            <PlaceholderPage
              title="Connect your wallet"
              description="Connect a wallet above to create this pool. Your token selection will be kept."
              readOnly
            />
          ) : (
            <PoolCreatePage key={writeRevision} config={config} />
          )
        }
      />
      <Route
        path="/pools/:token0/:token1"
        element={
          <PoolRoute config={config} view="detail" readOnly={readOnly} />
        }
      />
      <Route
        path="/pools/:token0/:token1/swap"
        element={
          readOnly ? (
            <ReadOnlyPoolRedirect />
          ) : (
            <PoolRoute
              key={writeRevision}
              config={config}
              view="swap"
              readOnly={readOnly}
            />
          )
        }
      />
      <Route
        path="/pools/:token0/:token1/liquidity"
        element={
          readOnly ? (
            <ReadOnlyPoolRedirect />
          ) : (
            <PoolRoute
              key={writeRevision}
              config={config}
              view="liquidity"
              readOnly={readOnly}
            />
          )
        }
      />
      <Route path="*" element={<NotFoundPage readOnly={readOnly} />} />
    </Routes>
  );
}
