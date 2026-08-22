import { AlertCircleIcon } from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
  NetworkIdentityError,
  PoolIdentityError,
  PoolNotFoundError,
  resolvePoolConfig,
} from "@/pools/pool-context";
import { parsePoolRoute } from "@/pools/pool-route";
import {
  createSnapshotReader,
  type SnapshotReader,
} from "@/swap/snapshot";
import { SwapPage } from "@/swap/swap-page";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import {
  createRequestObserver,
  type RequestObserver,
} from "@/transactions/request-observer";
import {
  unavailableWriteBoundary,
  type WriteBoundary,
} from "@/transactions/write-boundary";

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
  if (suppliedConfig !== undefined) {
    return (
      <TooltipProvider>
        <ConfiguredApp
          config={suppliedConfig}
          readSnapshot={readSnapshot}
          requestObserver={requestObserver}
          writeBoundary={writeBoundary ?? unavailableWriteBoundary}
        />
      </TooltipProvider>
    );
  }
  const configuration = readBrowserConfiguration();

  return (
    <TooltipProvider>
      {configuration.ok ? (
        <BrowserRouter>
          <AmmRoutes config={configuration.config} />
        </BrowserRouter>
      ) : <ConfigurationErrorPage message={configuration.message} />}
    </TooltipProvider>
  );
}

export function AmmRoutes({ config }: { config: GlobalConfig }) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/pools" replace />} />
      <Route path="/pools" element={<PlaceholderPage title="Pools" />} />
      <Route path="/pools/new" element={<PlaceholderPage title="Create pool" />} />
      <Route
        path="/pools/:token0/:token1"
        element={<PoolRoute config={config} view="detail" />}
      />
      <Route
        path="/pools/:token0/:token1/swap"
        element={<PoolRoute config={config} view="swap" />}
      />
      <Route
        path="/pools/:token0/:token1/liquidity"
        element={<PoolRoute config={config} view="liquidity" />}
      />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function PoolRoute({
  config,
  view,
}: {
  config: GlobalConfig;
  view: "detail" | "swap" | "liquidity";
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
          message: error instanceof PoolIdentityError
              || error instanceof NetworkIdentityError
            ? error.message
            : "The pool could not be loaded",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [config, parsed.kind, params.token0, params.token1]);

  if (parsed.kind === "invalid") return <NotFoundPage />;
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
      />
    );
  }
  if (state.kind === "missing") {
    return (
      <PlaceholderPage
        title="Pool not found"
        description="This canonical token pair has not been created."
      />
    );
  }
  if (state.kind === "error") {
    return (
      <PlaceholderPage title="Pool unavailable" description={state.message} />
    );
  }
  const requestKey = poolRequestKey(config, parsed.token0Hex, parsed.token1Hex);
  if (state.kind !== "ready" || state.key !== requestKey) {
    return (
      <PlaceholderPage
        title="Loading pool"
        description="Reading the factory and token metadata."
      />
    );
  }
  if (view === "swap") {
    return <ConfiguredApp key={poolRuntimeKey(state.config)} config={state.config} />;
  }
  return (
    <PlaceholderPage
      title={view === "detail" ? "Pool detail" : "Manage liquidity"}
      description="This route is ready for the next AMM implementation phase."
    />
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
    toHex0x(config.pairAddress),
    toHex0x(config.handlerAddress),
    toHex0x(config.driverAddress),
  ].join(":");
}

function PlaceholderPage({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <main className="isolate min-h-svh bg-background px-4 py-12 text-foreground antialiased sm:px-6">
      <Card className="mx-auto w-full max-w-xl">
        <CardHeader>
          <CardTitle asChild>
            <h1>{title}</h1>
          </CardTitle>
          {description === undefined ? null : (
            <CardDescription>{description}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex gap-3">
          <Link className="underline underline-offset-4" to="/pools">
            Pools
          </Link>
          <Link className="underline underline-offset-4" to="/pools/new">
            Create pool
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}

function NotFoundPage() {
  return (
    <PlaceholderPage
      title="Page not found"
      description="The requested AMM route is invalid."
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
  const [writer] = useState<WriteBoundary>(
    () => writeBoundary ?? createBrowserLocalWriteBoundary(config),
  );
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
    <main className="isolate flex min-h-svh items-center bg-background px-4 py-12 text-foreground antialiased sm:px-6">
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
  );
}

function readBrowserConfiguration():
  | { ok: true; config: GlobalConfig }
  | { ok: false; message: string } {
  try {
    return {
      ok: true,
      config: loadGlobalConfig({
        VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
        VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
        VITE_GROUNDHOG_WALLET_ADDRESS:
          import.meta.env.VITE_GROUNDHOG_WALLET_ADDRESS,
        VITE_GROUNDHOG_WALLET_ENTRYPOINT:
          import.meta.env.VITE_GROUNDHOG_WALLET_ENTRYPOINT,
        VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
        VITE_SWAP_FACTORY_ADDRESS: import.meta.env.VITE_SWAP_FACTORY_ADDRESS,
        VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
        VITE_POOL_CONTRACT_FUNDING:
          import.meta.env.VITE_POOL_CONTRACT_FUNDING,
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
