import { toHex0x } from "@groundhogchain/client";
import { useEffect, useRef } from "react";
import { RefreshCwIcon } from "lucide-react";
import { AllowanceCleanupCard } from "@/components/allowance-cleanup-card";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { AppConfig } from "@/config";
import { AmmPage } from "@/pools/amm-page";
import type { RequestObserver } from "@/transactions/request-observer";
import type { WriteBoundary } from "@/transactions/write-boundary";
import type { SnapshotReader } from "./snapshot";
import { usePoolSnapshot } from "./use-pool-snapshot";
import { SwapWorkspace } from "./swap-workspace";

export function SwapPage({
  config,
  readSnapshot,
  requestObserver,
  writeBoundary,
}: {
  config: AppConfig;
  readSnapshot: SnapshotReader;
  requestObserver: RequestObserver;
  writeBoundary: WriteBoundary;
}) {
  const state = usePoolSnapshot(readSnapshot, config);
  const heading = useRef<HTMLHeadingElement>(null);
  const recovering = useRef(false);
  useEffect(() => {
    if (state.error !== null && state.snapshot === null)
      recovering.current = true;
    else if (state.snapshot !== null && recovering.current) {
      recovering.current = false;
      heading.current?.focus();
    }
  }, [state.error, state.snapshot]);
  const status = state.isLoading
    ? "Loading pool data."
    : state.isUserRefreshing
      ? "Refreshing quote and pool data."
      : state.error !== null && state.snapshot !== null
        ? "Refresh failed. The previous pool data remains visible."
        : state.snapshot !== null
          ? `Pool data loaded at block ${state.snapshot.chainHeight}.`
          : "Pool data is unavailable.";
  return (
    <AmmPage
      title={`Swap ${config.tokenASymbol} / ${config.tokenBSymbol}`}
      description="Trade an exact input amount against this pool's current reserves."
    >
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <BlockchainIdentifier
          kind="address"
          value={toHex0x(config.tokenAAddress)}
          label="Token A address"
        />
        <BlockchainIdentifier
          kind="address"
          value={toHex0x(config.tokenBAddress)}
          label="Token B address"
        />
      </div>
      <div
        aria-busy={state.isLoading || state.isRefreshing}
        className="flex flex-col gap-6"
      >
        {state.isLoading && state.error === null ? (
          <div
            className="grid gap-6 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]"
            aria-label="Loading pool"
          >
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-4 w-64 max-w-full" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-36 w-full" />
                <Skeleton className="h-36 w-full" />
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          </div>
        ) : null}
        {state.snapshot === null && state.error !== null ? (
          <Card className="mx-auto w-full max-w-xl">
            <CardHeader>
              <CardTitle asChild>
                <h1>RPC unavailable</h1>
              </CardTitle>
              <CardDescription>
                Check the configured endpoint and confirm that setup completed
                on the expected ledger.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Alert variant="destructive">
                <AlertTitle>
                  Configured pool data could not be loaded
                </AlertTitle>
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            </CardContent>
            <CardFooter>
              <Button
                type="button"
                variant="outline"
                disabled={state.isLoading}
                onClick={state.refresh}
                className="min-h-12 sm:min-h-9"
              >
                {state.isLoading ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                {state.isLoading ? "Retrying" : "Retry"}
              </Button>
            </CardFooter>
          </Card>
        ) : null}
        {state.snapshot === null ? (
          <AllowanceCleanupCard
            config={config}
            snapshot={null}
            readSnapshot={readSnapshot}
            writer={writeBoundary}
            onRefresh={state.refresh}
          />
        ) : (
          <SwapWorkspace
            config={config}
            snapshot={state.snapshot}
            refreshError={state.error}
            isUserRefreshing={state.isUserRefreshing}
            headingRef={heading}
            readSnapshot={readSnapshot}
            requestObserver={requestObserver}
            refreshSnapshot={state.refresh}
            writeBoundary={writeBoundary}
          />
        )}
      </div>
    </AmmPage>
  );
}
