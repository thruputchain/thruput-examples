import { AlertCircleIcon } from "lucide-react";
import { toBase58 } from "@thruputchain/client";
import { useState } from "react";
import { useClient } from "@thruputchain/react";
import { Link } from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppConfig } from "@/config";
import { PoolPage } from "@/pools/pool-page";
import { poolPath } from "@/pools/pool-route";
import { formatTokenAmount } from "@/swap/model";
import { createSnapshotReader, type PoolSnapshot } from "@/swap/snapshot";
import { usePoolSnapshot } from "@/swap/use-pool-snapshot";

export function PoolDetailPage({
  config,
  readOnly = false,
}: {
  config: AppConfig;
  readOnly?: boolean;
}) {
  const client = useClient();
  const [reader] = useState(() => createSnapshotReader(config, client));
  const state = usePoolSnapshot(reader, config);
  const path = poolPath(config.tokenAAddress, config.tokenBAddress);

  return (
    <PoolPage
      title={
        state.snapshot === null
          ? `${config.tokenASymbol} / ${config.tokenBSymbol}`
          : `${state.snapshot.tokenA.symbol} / ${state.snapshot.tokenB.symbol}`
      }
      description="Pool reserves, liquidity ownership, and contract identity."
    >
      {state.error === null ? null : (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Pool refresh failed</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{state.error}</p>
            <Button
              variant="outline"
              disabled={state.isLoading || state.isRefreshing}
              onClick={state.refresh}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {state.snapshot === null && state.isLoading ? <DetailSkeleton /> : null}
      {state.snapshot === null ? null : (
        <>
          {isEmptyPool(state.snapshot) ? (
            <Alert>
              <AlertCircleIcon aria-hidden="true" />
              <AlertTitle>Empty pool</AlertTitle>
              <AlertDescription>
                This pool has no usable liquidity. Initial liquidity may not
                have executed yet, or one of its reserves is zero.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Metric
              label={`${state.snapshot.tokenA.symbol} reserve`}
              value={formatTokenAmount(
                state.snapshot.reserve0,
                state.snapshot.tokenA.decimals,
                8,
              )}
            />
            <Metric
              label={`${state.snapshot.tokenB.symbol} reserve`}
              value={formatTokenAmount(
                state.snapshot.reserve1,
                state.snapshot.tokenB.decimals,
                8,
              )}
            />
            {readOnly ? null : (
              <>
                <Metric
                  label={`Your ${state.snapshot.tokenA.symbol} balance`}
                  value={`${formatTokenAmount(
                    state.snapshot.tokenA.balance,
                    state.snapshot.tokenA.decimals,
                    8,
                  )} ${state.snapshot.tokenA.symbol}`}
                />
                <Metric
                  label={`Your ${state.snapshot.tokenB.symbol} balance`}
                  value={`${formatTokenAmount(
                    state.snapshot.tokenB.balance,
                    state.snapshot.tokenB.decimals,
                    8,
                  )} ${state.snapshot.tokenB.symbol}`}
                />
              </>
            )}
            <Metric
              label="LP supply"
              value={`${formatTokenAmount(
                state.snapshot.liquidityTotalSupply,
                state.snapshot.liquidityTokenDecimals,
                8,
              )} ${state.snapshot.liquidityTokenSymbol}`}
            />
            {readOnly ? null : (
              <Metric
                label="Your LP share"
                value={formatShare(
                  state.snapshot.liquidityBalance,
                  state.snapshot.liquidityTotalSupply,
                )}
              />
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle asChild>
                <h2>Pool position</h2>
              </CardTitle>
              <CardDescription>
                Coherent at block {state.snapshot.chainHeight.toString()} · 1{" "}
                {state.snapshot.tokenA.symbol} ≈{" "}
                {formatRatio(
                  state.snapshot.reserve0,
                  state.snapshot.tokenA.decimals,
                  state.snapshot.reserve1,
                  state.snapshot.tokenB.decimals,
                )}{" "}
                {state.snapshot.tokenB.symbol}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  Protocol fees {state.snapshot.feeTo === null ? "off" : "on"}
                </Badge>
                {readOnly ? null : (
                  <Badge variant="secondary">
                    Your LP{" "}
                    {formatTokenAmount(
                      state.snapshot.liquidityBalance,
                      state.snapshot.liquidityTokenDecimals,
                      8,
                    )}{" "}
                    {state.snapshot.liquidityTokenSymbol}
                  </Badge>
                )}
              </div>
              {readOnly ? null : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button asChild>
                    <Link to={`${path}/swap`}>Swap</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link to={`${path}/liquidity`}>Manage liquidity</Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle asChild>
                <h2>Contracts</h2>
              </CardTitle>
              <CardDescription>
                Validated against the configured factory.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Address label="Pool" value={config.handlerAddress} />
                <Address label="Token A" value={config.tokenAAddress} />
                <Address label="Token B" value={config.tokenBAddress} />
                <Address
                  label="LP token"
                  value={config.liquidityTokenAddress}
                />
                <Address label="Handler" value={config.handlerAddress} />
                <Address label="Driver" value={config.driverAddress} />
              </dl>
            </CardContent>
          </Card>
        </>
      )}
    </PoolPage>
  );
}

function isEmptyPool(snapshot: PoolSnapshot): boolean {
  return (
    snapshot.reserve0 === 0n ||
    snapshot.reserve1 === 0n ||
    snapshot.liquidityTotalSupply === 0n
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="font-mono text-xl tabular-nums">
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function Address({
  label,
  value,
}: {
  label: string;
  value: AppConfig["handlerAddress"];
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0">
        <BlockchainIdentifier
          kind="address"
          value={toBase58(value)}
          label={`${label} address`}
        />
      </dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      aria-label="Loading pool details"
      role="status"
    >
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-24" />
      ))}
    </div>
  );
}

function formatShare(balance: bigint, supply: bigint): string {
  if (supply === 0n) return "0%";
  const hundredths = (balance * 10_000n) / supply;
  if (balance > 0n && hundredths === 0n) return "<0.01%";
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
}

function formatRatio(
  reserve0: bigint,
  decimals0: number,
  reserve1: bigint,
  decimals1: number,
): string {
  if (reserve0 === 0n) return "—";
  const scale = 1_000_000n;
  const ratio =
    (reserve1 * 10n ** BigInt(decimals0) * scale) /
    (reserve0 * 10n ** BigInt(decimals1));
  if (reserve1 > 0n && ratio === 0n) return "<0.000001";
  return `${ratio / scale}.${(ratio % scale).toString().padStart(6, "0")}`
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}
