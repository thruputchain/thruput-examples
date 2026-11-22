import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertCircleIcon } from "lucide-react";
import { toBase58 } from "@thruputchain/client";
import type { AppConfig } from "@/config";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatAmount } from "@/domain/amount";
import { typedAddress } from "@/lib/address";
import { userErrorMessage } from "@/lib/errors";
import { addressFromBase58 } from "@thruputchain/client";
import { useQueuedRequest } from "@/transactions/use-queued-request";
import { AddLiquidityForm, RemoveLiquidityForm } from "./liquidity-forms";
import { RequestStatus } from "./request-status";
import { SwapForm } from "./swap-form";
import { usePool, usePoolState, useReader } from "./use-pool";

type Tab = "swap" | "add" | "remove";

/** One pool: its reserves, and swap and liquidity forms. */
export function PoolPage({ config }: { config: AppConfig }) {
  const params = useParams();
  const tokenA = typedAddress(params.token0 ?? "");
  const tokenB = typedAddress(params.token1 ?? "");
  const { reader, account, connected } = useReader(config);
  const pool = usePool(
    reader,
    tokenA ? addressFromBase58(tokenA) : null,
    tokenB ? addressFromBase58(tokenB) : null,
  );
  const state = usePoolState(reader, pool.data);
  const request = useQueuedRequest(config.networkId, account);
  const [tab, setTab] = useState<Tab>("swap");

  if (!tokenA || !tokenB || tokenA === tokenB)
    return <Message title="Pool not found" text="The address in the link is not a token pair." />;
  if (pool.error)
    return (
      <Message
        title="Pool unavailable"
        text={userErrorMessage(pool.error, "The factory could not be read.")}
      />
    );
  if (pool.isPending) return <main className="mx-auto max-w-4xl p-6"><Skeleton className="h-64" /></main>;
  if (pool.data === null)
    return (
      <Message title="No pool for these tokens" text="Create it, and add the first liquidity.">
        <Button asChild>
          <Link to={`/pools/new?tokenA=${tokenA}&tokenB=${tokenB}`}>Create pool</Link>
        </Button>
      </Message>
    );

  const { token0, token1 } = pool.data;
  return (
    <main className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-10 sm:px-6 md:grid-cols-[1fr_1fr]">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="app-page-title">
            {token0.symbol} / {token1.symbol}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {token0.name} · {token1.name}
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Reserves</CardTitle>
            <CardDescription>Refreshed every few seconds.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {state.data ? (
              <>
                <p>
                  {formatAmount(state.data.reserves[0], token0.decimals)} {token0.symbol}
                </p>
                <p>
                  {formatAmount(state.data.reserves[1], token1.decimals)} {token1.symbol}
                </p>
              </>
            ) : (
              <Skeleton className="h-10" />
            )}
            <p className="text-muted-foreground">
              Pool:{" "}
              <BlockchainIdentifier
                kind="address"
                label="Pool handler address"
                value={toBase58(pool.data.handler)}
              />
            </p>
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <RequestStatus request={request} />
        <Card>
          <CardHeader>
            <ToggleGroup
              type="single"
              variant="outline"
              value={tab}
              onValueChange={(value) => value && setTab(value as Tab)}
              aria-label="Action"
            >
              <ToggleGroupItem value="swap">Swap</ToggleGroupItem>
              <ToggleGroupItem value="add">Add liquidity</ToggleGroupItem>
              <ToggleGroupItem value="remove">Remove liquidity</ToggleGroupItem>
            </ToggleGroup>
          </CardHeader>
          <CardContent>
            {!connected ? (
              <p className="text-muted-foreground">
                Connect a wallet to swap or manage liquidity.
              </p>
            ) : !state.data ? (
              <Skeleton className="h-40" />
            ) : tab === "swap" ? (
              <SwapForm {...{ config, reader, account, request }} pool={pool.data} state={state.data} />
            ) : tab === "add" ? (
              <AddLiquidityForm {...{ config, reader, account, request }} pool={pool.data} state={state.data} />
            ) : (
              <RemoveLiquidityForm {...{ config, reader, account, request }} pool={pool.data} state={state.data} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function Message({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-4 px-4 py-10">
      <Alert>
        <AlertCircleIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{text}</AlertDescription>
      </Alert>
      {children}
    </main>
  );
}
