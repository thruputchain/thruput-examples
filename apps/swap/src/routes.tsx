import { addressFromHex, toHex0x } from "@groundhogchain/client";
import { useMemo, useState } from "react";
import { getClientQueryKey, useClient, useWallet, useWalletClient } from "@groundhogchain/react";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";

import { AppHeader } from "@/components/app-header";
import { ProcessingModeProvider } from "@/components/processing-mode";
import { ExplorerProvider } from "@/components/explorer-context";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type AppConfig,
  type GlobalConfig,
  READ_ONLY_CALLER,
} from "@/config";
import {
  PoolIdentityError,
  PoolNotFoundError,
  resolvePoolConfig,
} from "@/pools/pool-context";
import { PoolDetailPage } from "@/pools/pool-detail-page";
import { PoolCreatePage } from "@/pools/pool-create-page";
import { PoolDirectoryPage } from "@/pools/pool-directory-page";
import { LiquidityPage } from "@/pools/liquidity-page";
import { parsePoolRoute } from "@/pools/pool-route";
import { createSnapshotReader, type SnapshotReader } from "@/swap/snapshot";
import { SwapPage } from "@/swap/swap-page";
import {
  createRequestObserver,
  type RequestObserver,
} from "@/transactions/request-observer";
import { type WriteBoundary } from "@/transactions/write-boundary";
import { WalletControls } from "@/wallet/wallet-controls";
import { WalletInstallBanner } from "@/wallet/wallet-controls";
import { useTransactions } from "@/transactions/use-transactions";

export function AppProviders({
  children,
  explorerUrl,
}: {
  children: React.ReactNode;
  explorerUrl?: string | undefined;
}) {
  return (
    <TooltipProvider>
      <ExplorerProvider value={explorerUrl}>
        <ProcessingModeProvider>{children}</ProcessingModeProvider>
      </ExplorerProvider>
    </TooltipProvider>
  );
}

export function BrowserConfiguredApp({
  config: baseConfig,
}: {
  config: GlobalConfig;
}) {
  const wallet = useWallet();
  const binding = useWalletClient();
  const address = wallet.status === "connected" ? wallet.address : null;
  const config = useMemo(() => ({ ...baseConfig, accountAddress: address ? addressFromHex(address) : READ_ONLY_CALLER }), [baseConfig, address]);
  const [scope, setScope] = useState({ binding, revision: 0 });
  if (scope.binding !== binding) setScope({ binding, revision: scope.revision + 1 });
  return <><WalletInstallBanner /><AmmRoutes config={config} readOnly={wallet.status !== "connected"} writeRevision={scope.revision} /></>;
}

export function AmmRoutes({
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
            <PoolRoute key={writeRevision} config={config} view="swap" readOnly={readOnly} />
          )
        }
      />
      <Route
        path="/pools/:token0/:token1/liquidity"
        element={
          readOnly ? (
            <ReadOnlyPoolRedirect />
          ) : (
            <PoolRoute key={writeRevision} config={config} view="liquidity" readOnly={readOnly} />
          )
        }
      />
      <Route path="*" element={<NotFoundPage readOnly={readOnly} />} />
    </Routes>
  );
}

function ReadOnlyPoolRedirect() {
  const params = useParams();
  const parsed = parsePoolRoute(params.token0, params.token1);
  return parsed.kind === "invalid" ? (
    <Navigate to="/pools" replace />
  ) : (
    <Navigate to={`/pools/${parsed.token0Hex}/${parsed.token1Hex}`} replace />
  );
}

function PoolRoute({
  config,
  view,
  readOnly = false,
}: {
  config: GlobalConfig;
  view: "detail" | "swap" | "liquidity";
  readOnly?: boolean;
}) {
  const client = useClient();
  const params = useParams();
  const location = useLocation();
  const parsed = parsePoolRoute(params.token0, params.token1);
  const pool = useQuery({
    queryKey: [...getClientQueryKey(client), "pool-config", poolRequestKey(config, params.token0 ?? "", params.token1 ?? "")],
    queryFn: parsed.kind !== "canonical" ? skipToken : async ({ signal }) => {
      const result = await resolvePoolConfig(config, parsed.token0, parsed.token1, undefined, client);
      signal.throwIfAborted();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (parsed.kind === "invalid") return <NotFoundPage readOnly={readOnly} />;
  if (parsed.kind === "redirect") {
    const suffix = view === "detail" ? "" : `/${view}`;
    return (
      <Navigate
        replace
        to={`/pools/${parsed.token0Hex}/${parsed.token1Hex}${suffix}${location.search}`}
      />
    );
  }
  if (pool.isPending || pool.isFetching) {
    return (
      <PlaceholderPage
        title="Loading pool"
        description="Reading the factory and token metadata."
        readOnly={readOnly}
      />
    );
  }
  if (pool.error instanceof PoolNotFoundError) {
    return (
      <PlaceholderPage
        title="Pool not found"
        description="This canonical token pair has not been created."
        readOnly={readOnly}
      />
    );
  }
  if (pool.isError) {
    return (
      <PlaceholderPage
        title="Pool unavailable"
        description={pool.error instanceof PoolIdentityError ? pool.error.message : "The pool could not be loaded"}
        readOnly={readOnly}
      />
    );
  }
  const poolConfig = pool.data;
  if (view === "swap") {
    return (
      <ConfiguredApp key={poolRuntimeKey(poolConfig)} config={poolConfig} />
    );
  }
  if (view === "detail") {
    return (
      <PoolDetailPage
        key={poolRuntimeKey(poolConfig)}
        config={poolConfig}
        readOnly={readOnly}
      />
    );
  }
  return (
    <LiquidityPage key={poolRuntimeKey(poolConfig)} config={poolConfig} />
  );
}

function poolRequestKey(
  config: GlobalConfig,
  token0Hex: string,
  token1Hex: string,
): string {
  return [
    config.networkIdHex,
    toHex0x(config.accountAddress),
    toHex0x(config.factoryAddress),
    token0Hex,
    token1Hex,
  ].join(":");
}

function poolRuntimeKey(config: AppConfig): string {
  return [
    poolRequestKey(
      config,
      toHex0x(config.tokenAAddress),
      toHex0x(config.tokenBAddress),
    ),
    toHex0x(config.handlerAddress),
    toHex0x(config.driverAddress),
  ].join(":");
}

function PlaceholderPage({
  title,
  description,
  readOnly = false,
}: {
  title: string;
  description?: string;
  readOnly?: boolean;
}) {
  return (
    <>
      <AppHeader
        product="Swap"
        homeHref="/pools"
        actions={<WalletControls />}
      />
      <main className="isolate min-h-[calc(100svh-5rem)] bg-background px-4 py-12 text-foreground antialiased sm:px-6">
        <Card className="mx-auto w-full max-w-xl">
          <CardHeader>
            <CardTitle asChild>
              <h1>{title}</h1>
            </CardTitle>
            {description === undefined ? null : (
              <CardDescription>{description}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-3">
              <Link className="underline underline-offset-4" to="/pools">
                Pools
              </Link>
              {readOnly ? null : (
                <Link className="underline underline-offset-4" to="/pools/new">
                  Create pool
                </Link>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </>
  );
}

function NotFoundPage({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <PlaceholderPage
      title="Page not found"
      description="The requested AMM route is invalid."
      readOnly={readOnly}
    />
  );
}

export function ConfiguredApp({
  config,
  readSnapshot,
  requestObserver,
  writeBoundary,
}: {
  config: AppConfig;
  readSnapshot?: SnapshotReader | undefined;
  requestObserver?: RequestObserver | undefined;
  writeBoundary?: WriteBoundary | undefined;
}) {
  const client = useClient();
  const [reader] = useState<SnapshotReader>(
    () => readSnapshot ?? createSnapshotReader(config, client),
  );
  const connectedWriter = useTransactions(config);
  const writer = writeBoundary ?? connectedWriter;
  const [observer] = useState<RequestObserver>(
    () => requestObserver ?? createRequestObserver(config, client),
  );
  return (
    <SwapPage
      config={config}
      readSnapshot={reader}
      requestObserver={observer}
      writeBoundary={writer}
    />
  );
}
