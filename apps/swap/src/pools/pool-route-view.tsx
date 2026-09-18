import { toHex0x } from "@groundhogchain/client";
import { getClientQueryKey, useClient } from "@groundhogchain/react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type AppConfig, type GlobalConfig } from "@/config";
import {
  PoolIdentityError,
  PoolNotFoundError,
  resolvePoolConfig,
} from "@/pools/pool-context";
import { PoolDetailPage } from "@/pools/pool-detail-page";
import { LiquidityPage } from "@/pools/liquidity-page";
import { parsePoolRoute } from "@/pools/pool-route";
import { SwapRoute } from "@/swap/swap-route";

export function ReadOnlyPoolRedirect() {
  const params = useParams();
  const parsed = parsePoolRoute(params.token0, params.token1);
  return parsed.kind === "invalid" ? (
    <Navigate to="/pools" replace />
  ) : (
    <Navigate to={`/pools/${parsed.token0Hex}/${parsed.token1Hex}`} replace />
  );
}

export function PoolRoute({
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
    queryKey: [
      ...getClientQueryKey(client),
      "pool-config",
      poolRequestKey(config, params.token0 ?? "", params.token1 ?? ""),
    ],
    queryFn:
      parsed.kind !== "canonical"
        ? skipToken
        : async ({ signal }) => {
            const result = await resolvePoolConfig({
              config,
              token0: parsed.token0,
              token1: parsed.token1,
              client,
            });
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
        description={
          pool.error instanceof PoolIdentityError
            ? pool.error.message
            : "The pool could not be loaded"
        }
        readOnly={readOnly}
      />
    );
  }
  const poolConfig = pool.data;
  if (view === "swap") {
    return <SwapRoute key={poolRuntimeKey(poolConfig)} config={poolConfig} />;
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
  return <LiquidityPage key={poolRuntimeKey(poolConfig)} config={poolConfig} />;
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

export function PlaceholderPage({
  title,
  description,
  readOnly = false,
}: {
  title: string;
  description?: string;
  readOnly?: boolean;
}) {
  return (
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
  );
}

export function NotFoundPage({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <PlaceholderPage
      title="Page not found"
      description="The requested AMM route is invalid."
      readOnly={readOnly}
    />
  );
}
