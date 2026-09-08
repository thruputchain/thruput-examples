import { AlertCircleIcon } from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useInRouterContext,
  useLocation,
  useParams,
} from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  ConfigurationError,
  loadGlobalConfig,
  type AppConfig,
  type GlobalConfig,
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
import {
  unavailableWriteBoundary,
  type WriteBoundary,
} from "@/transactions/write-boundary";
import { ConnectedWalletApp } from "@/wallet/connected-app";
import { useWalletWriteBoundary } from "@/wallet/write-context";

export function App({
  config: suppliedConfig,
  readSnapshot,
  requestObserver,
  writeBoundary,
}: {
  config?: AppConfig;
  readSnapshot?: SnapshotReader | undefined;
  requestObserver?: RequestObserver | undefined;
  writeBoundary?: WriteBoundary | undefined;
} = {}) {
  const hasRouter = useInRouterContext();
  if (suppliedConfig !== undefined) {
    const app = (
      <ConfiguredApp
        config={suppliedConfig}
        readSnapshot={readSnapshot}
        requestObserver={requestObserver}
        writeBoundary={writeBoundary ?? unavailableWriteBoundary}
      />
    );
    return (
      <AppProviders explorerUrl={suppliedConfig.explorerUrl}>
        {hasRouter ? app : <BrowserRouter>{app}</BrowserRouter>}
      </AppProviders>
    );
  }
  const configuration = readBrowserConfiguration();

  return (
    <AppProviders
      explorerUrl={
        configuration.ok ? configuration.config.explorerUrl : undefined
      }
    >
      {configuration.ok ? (
        hasRouter ? (
          <BrowserConfiguredApp config={configuration.config} />
        ) : (
          <BrowserRouter>
            <BrowserConfiguredApp config={configuration.config} />
          </BrowserRouter>
        )
      ) : (
        <ConfigurationErrorPage message={configuration.message} />
      )}
    </AppProviders>
  );
}

function AppProviders({
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

function BrowserConfiguredApp({
  config: baseConfig,
}: {
  config: GlobalConfig;
}) {
  return (
    <ConnectedWalletApp config={baseConfig}>
      {(config, connected, revision) => (
        <AmmRoutes key={revision} config={config} readOnly={!connected} />
      )}
    </ConnectedWalletApp>
  );
}

export function AmmRoutes({
  config,
  readOnly = false,
}: {
  config: GlobalConfig;
  readOnly?: boolean;
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
            <Navigate to="/pools" replace />
          ) : (
            <PoolCreatePage config={config} />
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
            <PoolRoute config={config} view="swap" readOnly={readOnly} />
          )
        }
      />
      <Route
        path="/pools/:token0/:token1/liquidity"
        element={
          readOnly ? (
            <ReadOnlyPoolRedirect />
          ) : (
            <PoolRoute config={config} view="liquidity" readOnly={readOnly} />
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
  const params = useParams();
  const location = useLocation();
  const parsed = parsePoolRoute(params.token0, params.token1);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; key: string; config: AppConfig }
    | { kind: "missing" }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    if (parsed.kind !== "canonical") return;
    const key = poolRequestKey(config, parsed.token0Hex, parsed.token1Hex);
    let active = true;
    setState({ kind: "loading" });
    void resolvePoolConfig(config, parsed.token0, parsed.token1).then(
      (poolConfig) => {
        if (active) setState({ kind: "ready", key, config: poolConfig });
      },
      (error: unknown) => {
        if (!active) return;
        if (error instanceof PoolNotFoundError) {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "error",
          message:
            error instanceof PoolIdentityError
              ? error.message
              : "The pool could not be loaded",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [config, parsed.kind, params.token0, params.token1]);

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
  if (state.kind === "loading") {
    return (
      <PlaceholderPage
        title="Loading pool"
        description="Reading the factory and token metadata."
        readOnly={readOnly}
      />
    );
  }
  if (state.kind === "missing") {
    return (
      <PlaceholderPage
        title="Pool not found"
        description="This canonical token pair has not been created."
        readOnly={readOnly}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <PlaceholderPage
        title="Pool unavailable"
        description={state.message}
        readOnly={readOnly}
      />
    );
  }
  const requestKey = poolRequestKey(config, parsed.token0Hex, parsed.token1Hex);
  if (state.kind !== "ready" || state.key !== requestKey) {
    return (
      <PlaceholderPage
        title="Loading pool"
        description="Reading the factory and token metadata."
        readOnly={readOnly}
      />
    );
  }
  if (view === "swap") {
    return (
      <ConfiguredApp key={poolRuntimeKey(state.config)} config={state.config} />
    );
  }
  if (view === "detail") {
    return (
      <PoolDetailPage
        key={poolRuntimeKey(state.config)}
        config={state.config}
        readOnly={readOnly}
      />
    );
  }
  return (
    <LiquidityPage key={poolRuntimeKey(state.config)} config={state.config} />
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
      <AppHeader product="Swap" homeHref="/pools" />
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

function ConfiguredApp({
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
  const [reader] = useState<SnapshotReader>(
    () => readSnapshot ?? createSnapshotReader(config),
  );
  const connectedWriter = useWalletWriteBoundary();
  const writer = writeBoundary ?? connectedWriter;
  const [observer] = useState<RequestObserver>(
    () => requestObserver ?? createRequestObserver(config),
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

function ConfigurationErrorPage({ message }: { message: string }) {
  return (
    <>
      <AppHeader product="Swap" />
      <main className="isolate flex min-h-[calc(100svh-5rem)] items-center bg-background px-4 py-12 text-foreground antialiased sm:px-6">
        <Card className="mx-auto w-full max-w-xl">
          <CardHeader>
            <CardTitle asChild>
              <h1>Configuration required</h1>
            </CardTitle>
            <CardDescription>
              Run the local setup command before starting the swap application.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertCircleIcon aria-hidden="true" />
              <AlertTitle>Generated configuration is unavailable</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </main>
    </>
  );
}

export function readBrowserConfiguration():
  { ok: true; config: GlobalConfig } | { ok: false; message: string } {
  try {
    return {
      ok: true,
      config: loadGlobalConfig({
        VITE_EXPLORER_URL: import.meta.env.VITE_EXPLORER_URL,
        VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
        VITE_POOL_REGISTRY_ENABLED: import.meta.env.VITE_POOL_REGISTRY_ENABLED,
        VITE_TOKEN_DISCOVERY_ENABLED: import.meta.env
          .VITE_TOKEN_DISCOVERY_ENABLED,
        VITE_STANDARD_TOKEN_FACTORY_ADDRESS: import.meta.env
          .VITE_STANDARD_TOKEN_FACTORY_ADDRESS,
        VITE_STANDARD_TOKEN_HASH: import.meta.env.VITE_STANDARD_TOKEN_HASH,
        VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
        VITE_POOL_TOKEN_HASH: import.meta.env.VITE_POOL_TOKEN_HASH,
        VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
        VITE_KNOWN_TOKEN_ADDRESSES: import.meta.env.VITE_KNOWN_TOKEN_ADDRESSES,
        VITE_SWAP_FACTORY_ADDRESS: import.meta.env.VITE_SWAP_FACTORY_ADDRESS,
        VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof ConfigurationError
          ? error.message
          : "Application configuration is invalid",
    };
  }
}
