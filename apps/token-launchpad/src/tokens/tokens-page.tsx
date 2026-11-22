import { AlertCircleIcon, RocketIcon } from "lucide-react";
import { toBase58 } from "@thruputchain/client";
import { Link } from "react-router-dom";
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
import { TokenCards } from "./token-cards";
import {
  PAGE_SIZE,
  useTokenDirectory,
  type DirectoryOptions,
} from "./use-token-directory";

export function TokensPage(props: DirectoryOptions) {
  const key = [
    props.config.networkId,
    toBase58(props.config.factoryAddress),
    toBase58(props.config.accountAddress),
    props.scope,
  ].join(":");
  return <TokenDirectory key={key} {...props} />;
}

function TokenDirectory(props: DirectoryOptions) {
  const state = useTokenDirectory(props);
  const { page, loading, error } = state;
  const hasSearch = state.search.trim() !== "";
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <div>
        <h1 className="app-page-title">
          {props.scope === "all" ? "Tokens" : "My Tokens"}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {props.scope === "all"
            ? "All tokens launched through this factory, newest first."
            : "Factory launches created by this wallet."}
        </p>
      </div>
      <Field>
        <FieldLabel htmlFor="token-search">Search tokens</FieldLabel>
        <Input
          id="token-search"
          type="search"
          value={state.search}
          placeholder="Name, symbol, or token address"
          onChange={(event) => state.setSearch(event.target.value)}
        />
      </Field>
      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Token list unavailable</AlertTitle>
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
      ) : page && page.tokens.length === 0 && state.offset === 0 ? (
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
                ? "Try a different name, symbol, or token address."
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
              Showing {state.offset + 1}-{state.offset + page.tokens.length}
            </p>
            {loading ? <span>Updating...</span> : null}
          </div>
          <TokenCards tokens={page.tokens} connected={!props.readOnly} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={loading || state.offset === 0}
              onClick={() =>
                state.setOffset(Math.max(0, state.offset - PAGE_SIZE))
              }
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={loading || !page.hasMore}
              onClick={() => state.setOffset(state.offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}
    </main>
  );
}
