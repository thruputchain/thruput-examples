import {
  AlertCircleIcon,
  CoinsIcon,
  DropletsIcon,
  RefreshCwIcon,
  WalletCardsIcon,
} from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTokenAmount } from "@/swap/model";
import type {
  PortfolioLiquidityPosition,
  PortfolioToken,
  WalletPortfolio as WalletPortfolioValue,
  WalletPortfolioReader,
} from "@/wallet/portfolio";

const PORTFOLIO_MAX_FRACTION_DIGITS = 7;

interface PortfolioState {
  value: WalletPortfolioValue | null;
  error: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
}

export function WalletPortfolio({ read }: { read: WalletPortfolioReader }) {
  const request = useRef(0);
  const [state, setState] = useState<PortfolioState>({
    value: null,
    error: null,
    isLoading: true,
    isRefreshing: false,
  });
  const refresh = useCallback(() => {
    const currentRequest = ++request.current;
    setState((current) => ({
      ...current,
      error: null,
      isLoading: current.value === null,
      isRefreshing: current.value !== null,
    }));
    void read().then(
      (value) => {
        if (request.current !== currentRequest) return;
        setState({ value, error: null, isLoading: false, isRefreshing: false });
      },
      (error: unknown) => {
        if (request.current !== currentRequest) return;
        setState((current) => ({
          ...current,
          error: describeError(error),
          isLoading: false,
          isRefreshing: false,
        }));
      },
    );
  }, [read]);

  useEffect(() => {
    refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);

  const isEmpty =
    state.value !== null &&
    state.value.tokens.length === 0 &&
    state.value.liquidityPositions.length === 0;
  const status = state.isLoading
    ? "Loading portfolio"
    : state.isRefreshing
      ? "Refreshing portfolio"
      : state.error === null
        ? "Portfolio updated"
        : "";

  return (
    <section
      aria-labelledby="wallet-portfolio-title"
      className="flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 id="wallet-portfolio-title" className="font-medium">
            Portfolio
          </h3>
          <p className="text-xs text-muted-foreground">Known AMM assets</p>
        </div>
        <Button
          aria-label="Refresh portfolio"
          disabled={state.isLoading || state.isRefreshing}
          onClick={refresh}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <p className="sr-only" role="status">
        {status}
      </p>

      {state.isLoading ? <PortfolioSkeleton /> : null}
      {state.value !== null && !isEmpty ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          {state.value.tokens.length > 0 ? (
            <AssetGroup title="Tokens">
              {state.value.tokens.map((token) => (
                <TokenRow key={toHex0x(token.address)} token={token} />
              ))}
            </AssetGroup>
          ) : null}
          {state.value.liquidityPositions.length > 0 ? (
            <AssetGroup title="Liquidity">
              {state.value.liquidityPositions.map((position) => (
                <LiquidityRow
                  key={toHex0x(position.address)}
                  position={position}
                />
              ))}
            </AssetGroup>
          ) : null}
        </div>
      ) : null}
      {isEmpty ? (
        <Empty className="gap-2 p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WalletCardsIcon />
            </EmptyMedia>
            <EmptyTitle>No holdings yet</EmptyTitle>
            <EmptyDescription>
              This wallet has no known token or liquidity balances.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {state.value !== null &&
      (state.value.invalidPoolCount > 0 ||
        state.value.unavailableAssetCount > 0) ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Some assets are unavailable</AlertTitle>
          <AlertDescription>{unavailableMessage(state.value)}</AlertDescription>
        </Alert>
      ) : null}
      {state.error !== null ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>
            {state.value === null
              ? "Portfolio unavailable"
              : "Portfolio refresh failed"}
          </AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
          <AlertAction>
            <Button
              aria-label="Retry portfolio"
              onClick={refresh}
              size="icon-xs"
              type="button"
              variant="outline"
            >
              <RefreshCwIcon />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </section>
  );
}

function AssetGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="flex flex-col gap-1">{children}</ul>
    </div>
  );
}

function TokenRow({ token }: { token: PortfolioToken }) {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <CoinsIcon aria-hidden="true" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{token.symbol}</span>
        <span className="truncate text-xs text-muted-foreground">
          {token.name}
        </span>
      </span>
      <span className="max-w-28 truncate font-mono text-xs font-medium tabular-nums">
        {formatTokenAmount(
          token.balance,
          token.decimals,
          PORTFOLIO_MAX_FRACTION_DIGITS,
        )}
      </span>
    </li>
  );
}

function LiquidityRow({ position }: { position: PortfolioLiquidityPosition }) {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <DropletsIcon aria-hidden="true" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">
          {position.poolSymbols.join(" / ")}
        </span>
        <span className="text-xs text-muted-foreground">
          {position.symbol} token
        </span>
      </span>
      <span className="max-w-28 truncate font-mono text-xs font-medium tabular-nums">
        {formatTokenAmount(
          position.balance,
          position.decimals,
          PORTFOLIO_MAX_FRACTION_DIGITS,
        )}
      </span>
    </li>
  );
}

function PortfolioSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <div className="flex items-center gap-2 px-1 py-1.5" key={row}>
          <Skeleton className="size-8 shrink-0" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

function unavailableMessage(portfolio: WalletPortfolioValue): string {
  const messages = [];
  if (portfolio.invalidPoolCount > 0) {
    messages.push(
      `${portfolio.invalidPoolCount} pool registry ${portfolio.invalidPoolCount === 1 ? "entry" : "entries"} could not be read.`,
    );
  }
  if (portfolio.unavailableAssetCount > 0) {
    messages.push(
      `${portfolio.unavailableAssetCount} asset ${portfolio.unavailableAssetCount === 1 ? "contract" : "contracts"} could not be read.`,
    );
  }
  return messages.join(" ");
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "The configured RPC could not load this wallet's holdings.";
}
