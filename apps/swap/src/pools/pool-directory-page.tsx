import { addressFromHex, toHex0x } from "@groundhogchain/client";
import {
  AlertCircleIcon,
  DropletsIcon,
  LoaderCircleIcon,
  PlusIcon,
} from "lucide-react";
import { usePoolDirectory } from "./use-pool-directory";
export { DIRECTORY_REFRESH_INTERVAL_MS } from "./use-pool-directory";
import { Link } from "react-router-dom";

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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { GlobalConfig } from "@/config";
import { AmmPage } from "@/pools/amm-page";
import {
  type PoolDirectoryEntry,
} from "@/pools/pool-directory";
import { poolPath } from "@/pools/pool-route";
import {
  getPoolRegistryStatus,
  getRegistryPools,
  requestPoolRegistrySync,
  type RegistrySort,
} from "@/registry/client";
import {
  enrichRegistryPools,
} from "@/registry/pools";
import { formatTokenAmount } from "@/swap/model";

interface PoolDirectoryPageDependencies {
  readRegistry?: typeof getRegistryPools;
  readStatus?: typeof getPoolRegistryStatus;
  requestSync?: typeof requestPoolRegistrySync;
  enrich?: typeof enrichRegistryPools;
}


export function PoolDirectoryPage({
  config,
  dependencies = {},
  readOnly = false,
}: {
  config: GlobalConfig;
  dependencies?: PoolDirectoryPageDependencies;
  readOnly?: boolean;
}) {
  return (
    <RegistryPoolDirectoryPage
      config={config}
      read={dependencies.readRegistry ?? getRegistryPools}
      readStatus={dependencies.readStatus ?? getPoolRegistryStatus}
      requestSync={dependencies.requestSync ?? requestPoolRegistrySync}
      enrich={dependencies.enrich ?? enrichRegistryPools}
      readOnly={readOnly}
    />
  );
}

const PAGE_SIZE = 20;
const MAX_OFFSET = 10_000;

function RegistryPoolDirectoryPage({
  config,
  read,
  readStatus,
  requestSync,
  enrich,
  readOnly,
}: {
  config: GlobalConfig;
  read: typeof getRegistryPools;
  readStatus: typeof getPoolRegistryStatus;
  requestSync: typeof requestPoolRegistrySync;
  enrich: typeof enrichRegistryPools;
  readOnly: boolean;
}) {
  const { search, setSearch, token, setToken, sort, setSort, offset, page, entries, status, statusError, error, loading, hasFilters, refresh, changePage, resetSnapshot } = usePoolDirectory({ config, read, readStatus, requestSync, enrich });

  const failedReads = entries.filter(({ readError }) => readError).length;

  return (
    <DirectoryLayout readOnly={readOnly}>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_11rem]">
        <Field>
          <FieldLabel htmlFor="pool-search">Search addresses</FieldLabel>
          <Input
            id="pool-search"
            type="search"
            value={search}
            placeholder="Token, LP, handler, or driver"
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="pool-token">Contains token</FieldLabel>
          <Input
            id="pool-token"
            className="font-mono"
            value={token}
            placeholder="Exact 0x address"
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="pool-sort">Sort by</FieldLabel>
          <select
            id="pool-sort"
            className="h-9 w-full rounded-md border border-input bg-muted px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring sm:text-sm pointer-coarse:min-h-12"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as RegistrySort);
              resetSnapshot();
            }}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="token0">Token 0</option>
            <option value="token1">Token 1</option>
          </select>
        </Field>
      </div>

      {error !== null ? (
        page === null
          ? <Unavailable message={error} retry={refresh} />
          : <StaleDataAlert message={error} />
      ) : null}
      {loading && page === null ? <DirectorySkeleton /> : null}
      {page?.total === 0 ? (
        hasFilters ? (
          <NoMatches />
        ) : (
          <EmptyDirectory readOnly={readOnly} />
        )
      ) : null}
      {page !== null && page.total > 0 ? (
        <>
          <div
            className="flex items-center justify-between gap-4 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <p>
              Showing {page.offset + 1}-{page.offset + page.pools.length} of{" "}
              {page.total}
            </p>
            {loading ? <span>Updating...</span> : null}
          </div>
          <div role="status" aria-live="polite" className="sr-only">
            {entries.some(({ loading: entryLoading }) => entryLoading)
              ? "Loading current pool data"
              : "Current pool data loaded"}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {entries.map((entry) => (
              <PoolCard
                key={`${entry.record.token0Address}:${entry.record.token1Address}`}
                token0Address={entry.record.token0Address}
                token1Address={entry.record.token1Address}
                live={entry.live}
                loading={entry.loading}
                readOnly={readOnly}
              />
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={loading || offset === 0}
              onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={
                loading || !page.hasMore || offset + PAGE_SIZE > MAX_OFFSET
              }
              onClick={() => changePage(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}

      {status?.syncState === "integrityFault" ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Registry integrity fault</AlertTitle>
          <AlertDescription>
            {status.lastError ??
              "Indexing stopped because registry evidence failed validation. An operator must resolve the fault."}
          </AlertDescription>
        </Alert>
      ) : statusError ||
        status?.syncState === "retrying" ||
        status?.lastError ? (
        <Alert>
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Registry sync delayed</AlertTitle>
          <AlertDescription>
            {status?.lastError ??
              "Current pools are shown, but registry freshness could not be confirmed. Retrying automatically."}
          </AlertDescription>
        </Alert>
      ) : status?.syncState === "syncing" ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
          Syncing tokens...
        </p>
      ) : null}
      {page?.historyLimited || status?.historyLimited ? (
        <Alert>
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Older pool history is unavailable</AlertTitle>
          <AlertDescription>
            The registry started after some factory events left retained
            history, so these results are incomplete.
          </AlertDescription>
        </Alert>
      ) : null}
      {failedReads > 0 ? <PartialReads count={failedReads} /> : null}
    </DirectoryLayout>
  );
}

function DirectoryLayout({
  children,
  readOnly = false,
}: {
  children: React.ReactNode;
  readOnly?: boolean;
}) {
  return (
    <AmmPage
      title="Pools"
      description="Explore token markets on Thruput."
      readOnly={readOnly}
    >
      {children}
    </AmmPage>
  );
}

function Unavailable({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Pool registry unavailable</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>{message}</p>
        <Button type="button" variant="outline" onClick={retry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function StaleDataAlert({ message }: { message: string }) {
  return (
    <Alert>
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Pool data may be stale</AlertTitle>
      <AlertDescription>
        The last loaded pools remain visible. Retrying automatically. {message}
      </AlertDescription>
    </Alert>
  );
}

function PartialReads({
  count,
  direct = false,
}: {
  count: number;
  direct?: boolean;
}) {
  return (
    <Alert>
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Some pools could not be loaded</AlertTitle>
      <AlertDescription>
        {count} registry {count === 1 ? "entry was" : "entries were"}{" "}
        {direct ? "skipped" : "shown without current data"} because its live
        data was invalid or unavailable.
      </AlertDescription>
    </Alert>
  );
}

function EmptyDirectory({ readOnly = false }: { readOnly?: boolean }) {
  return (
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
      {readOnly ? null : (
        <EmptyContent>
          <Button asChild>
            <Link to="/pools/new">
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Create pool
            </Link>
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

function NoMatches() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DropletsIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No matching pools</EmptyTitle>
        <EmptyDescription>
          Try another address or remove the exact token filter.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function PoolCard({
  token0Address,
  token1Address,
  live,
  loading,
  readOnly = false,
}: {
  token0Address: string;
  token1Address: string;
  live: PoolDirectoryEntry | null;
  loading: boolean;
  readOnly?: boolean;
}) {
  const path = poolPath(
    addressFromHex(token0Address),
    addressFromHex(token1Address),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>
            {live === null
              ? <><BlockchainIdentifier kind="address" value={token0Address} label="Token 0 address" /> / <BlockchainIdentifier kind="address" value={token1Address} label="Token 1 address" /></>
              : `${live.snapshot.tokenA.symbol} / ${live.snapshot.tokenB.symbol}`}
          </h2>
        </CardTitle>
        <CardDescription>
          {loading
            ? "Loading current pool data..."
            : live === null
              ? "Current pool data unavailable"
              : "Canonical constant-product pool"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {live === null ? (
          <div className="grid gap-2 text-sm">
            <BlockchainIdentifier
              kind="address"
              value={token0Address}
              label="Token 0 address"
            />
            <BlockchainIdentifier
              kind="address"
              value={token1Address}
              label="Token 1 address"
            />
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              <BlockchainIdentifier kind="address" value={token0Address} label="Token 0 address" />
              <BlockchainIdentifier kind="address" value={token1Address} label="Token 1 address" />
            </div>
            <dl className="grid grid-cols-2 gap-4">
              <Reserve
                label={live.snapshot.tokenA.symbol}
                value={formatTokenAmount(
                  live.snapshot.reserve0,
                  live.snapshot.tokenA.decimals,
                  6,
                )}
              />
              <Reserve
                label={live.snapshot.tokenB.symbol}
                value={formatTokenAmount(
                  live.snapshot.reserve1,
                  live.snapshot.tokenB.decimals,
                  6,
                )}
              />
            </dl>
            <div className="mt-4 border-t border-foreground/10 pt-4 text-sm">
              <span className="mr-2 text-muted-foreground">Pool</span>
              <BlockchainIdentifier
                kind="address"
                value={toHex0x(live.config.handlerAddress)}
                label="Handler address"
              />
            </div>
          </>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to={path}>View pool</Link>
        </Button>
        {readOnly ? null : (
          <>
            <Button asChild size="sm" variant="outline">
              <Link to={`${path}/swap`}>Swap</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`${path}/liquidity`}>Liquidity</Link>
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
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
