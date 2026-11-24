import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toBase58 } from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import { AlertCircleIcon, DropletsIcon } from "lucide-react";
import type { AppConfig } from "@/config";
import {
  POOL_PAGE_SIZE,
  readPoolPage,
  readToken,
  tokenByAddress,
} from "@/contracts/swap";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { userErrorMessage } from "@/lib/errors";
import { useReader } from "./use-pool";

/**
 * Every pool the factory created, newest first. The factory keeps the list
 * on chain (`all_pairs_length` and `pair_at`), so this page needs no indexer.
 */
export function PoolListPage({ config }: { config: AppConfig }) {
  const { reader } = useReader(config);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  // The pool count the first page saw. Older pages count from it, so a pool
  // created while the visitor browses does not shift them.
  const [firstTotal, setFirstTotal] = useState<bigint | null>(null);
  const asOfTotal = page > 0 && firstTotal !== null ? firstTotal : undefined;
  const pools = useQuery({
    queryKey: ["pools", page, asOfTotal?.toString()],
    queryFn: async () => {
      const { total, pairs } = await readPoolPage(reader, page, asOfTotal);
      const rows = await Promise.all(
        pairs.map(async ([token0, token1]) => {
          // Any contract can be a pool token. One without the metadata views
          // is listed by its address, so it does not hide the other pools.
          const read = (token: ContractAddress) =>
            readToken(reader, token).catch(() => tokenByAddress(token));
          const [first, second] = await Promise.all([read(token0), read(token1)]);
          return { token0: first, token1: second };
        }),
      );
      return { total, rows };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (page === 0 && pools.data && !pools.isPlaceholderData)
      setFirstTotal(pools.data.total);
  }, [page, pools.data, pools.isPlaceholderData]);
  const text = filter.trim().toLowerCase();
  const rows = (pools.data?.rows ?? []).filter(
    ({ token0, token1 }) =>
      !text ||
      [token0, token1].some(
        (token) =>
          token.symbol.toLowerCase().includes(text) ||
          token.name.toLowerCase().includes(text) ||
          toBase58(token.address).toLowerCase() === text,
      ),
  );
  const pageCount = pools.data
    ? Math.max(1, Math.ceil(Number(pools.data.total) / POOL_PAGE_SIZE))
    : 1;
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="app-page-title">Pools</h1>
          <p className="mt-2 text-muted-foreground">
            Every pool this factory created, newest first.
          </p>
        </div>
        <Button asChild>
          <Link to="/pools/new">Create pool</Link>
        </Button>
      </div>
      <Input
        type="search"
        aria-label="Filter pools on this page"
        placeholder="Filter by symbol, name, or token address"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {pools.error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Pools unavailable</AlertTitle>
          <AlertDescription>
            {userErrorMessage(pools.error, "The factory could not be read.")}
          </AlertDescription>
        </Alert>
      ) : null}
      {pools.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : pools.data?.total === 0n ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DropletsIcon />
            </EmptyMedia>
            <EmptyTitle>No pools yet</EmptyTitle>
            <EmptyDescription>
              Create the first pool for two tokens.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Pools">
          {rows.map(({ token0, token1 }) => (
            <li key={`${toBase58(token0.address)}-${toBase58(token1.address)}`}>
              <Link
                className="flex items-center justify-between gap-4 p-4 hover:bg-muted"
                to={`/pools/${toBase58(token0.address)}/${toBase58(token1.address)}`}
              >
                <span className="font-medium">
                  {token0.symbol} / {token1.symbol}
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {token0.name} · {token1.name}
                </span>
              </Link>
            </li>
          ))}
          {rows.length === 0 ? (
            <li className="p-4 text-muted-foreground">
              No pools on this page match the filter.
            </li>
          ) : null}
        </ul>
      )}
      {pageCount > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Newer
          </Button>
          <Button
            variant="outline"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage(page + 1)}
          >
            Older
          </Button>
        </div>
      ) : null}
    </main>
  );
}
