import { AlertCircleIcon, RocketIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { ExplorerProvider } from "@/components/blockchain-identifier";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { RegistrySort } from "@/registry/client";
import { TokenCards } from "./token-cards";
import {
  useTokenDirectory,
  type DirectoryOptions,
} from "./use-token-directory";

export function TokensPage(props: DirectoryOptions) {
  const state = useTokenDirectory(props);
  const { page, tokens, status, loading, error } = state;
  const hasSearch = state.search.trim() !== "";
  return (
    <ExplorerProvider explorerUrl={props.config.explorerUrl}>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
        <div>
          <h1 className="app-page-title">
            {props.scope === "all" ? "Tokens" : "My Tokens"}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {props.scope === "all"
              ? "All tokens launched through this factory."
              : "Factory launches created by this wallet."}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field>
            <FieldLabel htmlFor="token-search">Search tokens</FieldLabel>
            <Input
              id="token-search"
              type="search"
              value={state.search}
              placeholder="Name, symbol, token, or creator"
              onChange={(event) => state.setSearch(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="token-sort">Sort by</FieldLabel>
            <select
              id="token-sort"
              className="h-9 w-full rounded-md border border-input bg-muted px-3 text-sm"
              value={state.sort}
              onChange={(event) =>
                state.setSort(event.target.value as RegistrySort)
              }
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="name">Name</option>
              <option value="symbol">Symbol</option>
            </select>
          </Field>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Registry unavailable</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <span>{error}</span>
              <Button variant="outline" onClick={state.refresh}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {loading && !page ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        ) : page?.total === 0 ? (
          <Empty className="border bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RocketIcon />
              </EmptyMedia>
              <EmptyTitle>
                {hasSearch ? "No matching tokens" : "No tokens yet"}
              </EmptyTitle>
              <EmptyDescription>
                {hasSearch
                  ? "Try a different name, symbol, token address, or creator address."
                  : props.scope === "all"
                    ? "No tokens have been launched through this factory."
                    : "Launch your first standard token from this wallet."}
              </EmptyDescription>
            </EmptyHeader>
            {!hasSearch && !props.readOnly ? (
              <Button asChild>
                <Link to="/create">Create token</Link>
              </Button>
            ) : null}
          </Empty>
        ) : page ? (
          <>
            <div
              className="flex items-center justify-between text-sm text-muted-foreground"
              aria-live="polite"
            >
              <p>
                Showing {page.offset + 1}-{page.offset + page.tokens.length} of{" "}
                {page.total}
              </p>
              {loading ? <span>Updating...</span> : null}
            </div>
            <div role="status" className="sr-only">
              {props.readOnly
                ? "Public token metadata loaded"
                : tokens.some((token) => token.balanceLoading)
                  ? "Loading current token balances"
                  : "Current token balances loaded"}
            </div>
            <TokenCards tokens={tokens} connected={!props.readOnly} />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={loading || state.offset === 0}
                onClick={() => state.changePage(Math.max(0, state.offset - 20))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={loading || !page.hasMore || state.offset + 20 > 10000}
                onClick={() => state.changePage(state.offset + 20)}
              >
                Next
              </Button>
            </div>
          </>
        ) : null}
        {status?.syncState === "integrityFault" ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Registry integrity fault</AlertTitle>
            <AlertDescription>
              {status.lastError ??
                "Indexing stopped because registry evidence failed validation. An operator must resolve the fault."}
            </AlertDescription>
          </Alert>
        ) : state.statusError ||
          status?.syncState === "retrying" ||
          status?.lastError ? (
          <Alert>
            <AlertTitle>Registry sync delayed</AlertTitle>
            <AlertDescription>
              {status?.lastError ??
                "Registry freshness could not be confirmed. Retrying automatically."}
            </AlertDescription>
          </Alert>
        ) : status?.syncing ? (
          <Alert>
            <AlertTitle>Registry is syncing</AlertTitle>
            <AlertDescription>
              New launches may appear after indexing reaches the chain tip.
            </AlertDescription>
          </Alert>
        ) : null}
        {page?.historyLimited || status?.historyLimited ? (
          <Alert>
            <AlertTitle>Older launch history is unavailable</AlertTitle>
            <AlertDescription>
              The registry started after some factory events had left retained
              history, so these results are incomplete.
            </AlertDescription>
          </Alert>
        ) : null}
        {!props.readOnly && tokens.some((token) => token.readError) ? (
          <Alert>
            <AlertTitle>Some current balances are unavailable</AlertTitle>
            <AlertDescription>
              Registry metadata is shown where live token balance views could
              not be read.
            </AlertDescription>
          </Alert>
        ) : null}
      </main>
    </ExplorerProvider>
  );
}
