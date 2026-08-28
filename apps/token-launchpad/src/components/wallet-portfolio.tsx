import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUnits } from "@/launch/form";
import type {
  WalletPortfolio as Portfolio,
  WalletPortfolioReader,
} from "@/wallet/portfolio";

export function WalletPortfolio({ read }: { read: WalletPortfolioReader }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; portfolio: Portfolio }
    | { kind: "error" }
  >({ kind: "loading" });
  const request = useRef(0);

  function refresh() {
    const current = ++request.current;
    setState({ kind: "loading" });
    void read().then(
      (portfolio) => {
        if (current === request.current) setState({ kind: "ready", portfolio });
      },
      () => {
        if (current === request.current) setState({ kind: "error" });
      },
    );
  }

  useEffect(() => {
    refresh();
    return () => {
      request.current += 1;
    };
  }, [read]);

  if (state.kind === "loading") {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }
  if (state.kind === "error") {
    return (
      <div className="space-y-2 text-sm">
        <p className="flex items-center gap-2 text-destructive" role="alert">
          <AlertCircleIcon className="size-4" /> Portfolio unavailable
        </p>
        <Button size="sm" variant="outline" onClick={refresh}>
          <RefreshCwIcon /> Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">HOG</span>
        <span className="font-mono font-medium">
          {state.portfolio.hogBalance === null ||
          state.portfolio.hogDecimals === null
            ? "Unavailable"
            : formatUnits(
                state.portfolio.hogBalance,
                state.portfolio.hogDecimals,
              )}
        </span>
      </div>
      {state.portfolio.tokens.map((token) => (
        <div
          className="flex items-center justify-between gap-3 text-sm"
          key={token.addressHex}
        >
          <span className="truncate text-muted-foreground">{token.symbol}</span>
          <span className="font-mono font-medium">
            {token.balance === null
              ? "Unavailable"
              : token.decimals === null
                ? `${token.balance} base units`
                : formatUnits(token.balance, token.decimals)}
          </span>
        </div>
      ))}
      {state.portfolio.partial ? (
        <p className="text-xs text-muted-foreground" role="status">
          Some holdings may be unavailable.
        </p>
      ) : null}
      <Button size="sm" variant="ghost" onClick={refresh}>
        <RefreshCwIcon /> Refresh balances
      </Button>
    </div>
  );
}
