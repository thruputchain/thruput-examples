import { AlertCircleIcon, DropletsIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { GlobalConfig } from "@/config";
import { poolPath } from "@/pools/pool-route";
import {
  readPoolDirectory,
  type PoolDirectoryResult,
} from "@/pools/pool-directory";
import { AmmPage } from "@/pools/amm-page";
import { formatTokenAmount } from "@/swap/model";

export function PoolDirectoryPage({ config }: { config: GlobalConfig }) {
  const request = useRef(0);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; result: PoolDirectoryResult; refreshing: boolean }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const refresh = useCallback((background = false) => {
    const currentRequest = ++request.current;
    setState((current) =>
      background && current.kind === "ready"
        ? { ...current, refreshing: true }
        : { kind: "loading" }
    );
    void readPoolDirectory(config).then(
      (result) => {
        if (request.current === currentRequest) {
          setState({ kind: "ready", result, refreshing: false });
        }
      },
      (error: unknown) => {
        if (request.current === currentRequest) {
          setState({
            kind: "error",
            message: error instanceof Error
              ? error.message
              : "The pool registry could not be loaded",
          });
        }
      },
    );
  }, [config]);

  useEffect(() => {
    refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);

  return (
    <AmmPage
      title="Pools"
      description="Factory-created markets available on this local Groundhog network."
      actions={state.kind === "ready" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state.refreshing}
          onClick={() => refresh(true)}
        >
          <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
          {state.refreshing ? "Refreshing" : "Refresh"}
        </Button>
      ) : undefined}
    >
      {state.kind === "loading" ? <DirectorySkeleton /> : null}
      {state.kind === "error" ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Pool registry unavailable</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{state.message}</p>
            <Button type="button" variant="outline" onClick={() => refresh()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {state.kind === "ready" && state.result.invalidEntryCount > 0 ? (
        <Alert>
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Some pools could not be loaded</AlertTitle>
          <AlertDescription>
            {state.result.invalidEntryCount} registry {state.result.invalidEntryCount === 1 ? "entry was" : "entries were"} skipped because its data was invalid or unavailable.
          </AlertDescription>
        </Alert>
      ) : null}
      {state.kind === "ready"
        && state.result.entries.length === 0
        && state.result.invalidEntryCount === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DropletsIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No pools yet</EmptyTitle>
            <EmptyDescription>
              Create and seed the first token pair in this factory.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/pools/new">
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Create pool
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
      {state.kind === "ready" && state.result.entries.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {state.result.entries.map(({ config: pool, snapshot }) => {
            const path = poolPath(pool.tokenAAddress, pool.tokenBAddress);
            return (
              <Card key={path}>
                <CardHeader>
                  <CardTitle asChild>
                    <h2>{snapshot.tokenA.symbol} / {snapshot.tokenB.symbol}</h2>
                  </CardTitle>
                  <CardDescription>Canonical constant-product pool</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-4">
                    <Reserve label={snapshot.tokenA.symbol} value={formatTokenAmount(snapshot.reserve0, snapshot.tokenA.decimals, 6)} />
                    <Reserve label={snapshot.tokenB.symbol} value={formatTokenAmount(snapshot.reserve1, snapshot.tokenB.decimals, 6)} />
                  </dl>
                </CardContent>
                <CardFooter className="flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link to={path}>View pool</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`${path}/swap`}>Swap</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`${path}/liquidity`}>Liquidity</Link>
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : null}
    </AmmPage>
  );
}

function Reserve({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label} reserve</dt>
      <dd className="mt-1 font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function DirectorySkeleton() {
  return (
    <div
      className="grid gap-4 md:grid-cols-2"
      aria-label="Loading pools"
      role="status"
    >
      {[0, 1].map((index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-52" />
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
