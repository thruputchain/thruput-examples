import { toHex0x } from "@groundhogchain/client";
import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "@/config";
import type { CreatedToken } from "@/contracts/launchpad-client";
import { userErrorMessage } from "@/errors";
import type { createReadClient } from "@/groundhog/client";
import {
  getRegistryStatus,
  getRegistryTokens,
  requestRegistrySync,
  type RegistrySort,
  type RegistryStatus,
  type RegistryTokenPage,
} from "@/registry/client";
import {
  enrichTokenBalances,
  registryTokenToCreatedToken,
} from "@/registry/tokens";

export interface DirectoryOptions {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
  scope: "all" | "mine";
  readOnly?: boolean;
  registryRead?: typeof getRegistryTokens;
  registryStatus?: typeof getRegistryStatus;
  registrySync?: typeof requestRegistrySync;
  enrichBalances?: typeof enrichTokenBalances;
}

export function useTokenDirectory({
  config,
  client,
  scope,
  readOnly = false,
  registryRead = getRegistryTokens,
  registryStatus = getRegistryStatus,
  registrySync = requestRegistrySync,
  enrichBalances = enrichTokenBalances,
}: DirectoryOptions) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RegistrySort>("newest");
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [page, setPage] = useState<RegistryTokenPage | null>(null);
  const [tokens, setTokens] = useState<CreatedToken[]>([]);
  const [status, setStatus] = useState<RegistryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [loading, setLoading] = useState(true);
  const snapshot = useRef<string | undefined>(undefined);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  function invalidate() {
    request.current?.abort();
    snapshot.current = undefined;
    setOffset(0);
  }
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      invalidate();
      setQuery(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, query]);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    busy.current = true;
    setLoading(true);
    setError(null);
    void registryRead(
      config,
      {
        ...(query ? { q: query } : {}),
        ...(scope === "mine"
          ? { creator: toHex0x(config.accountAddress) }
          : {}),
        sort,
        limit: 20,
        offset,
        ...(snapshot.current === undefined
          ? {}
          : { asOfBlock: snapshot.current }),
      },
      controller.signal,
    )
      .then(async (result) => {
        if (controller.signal.aborted) return;
        const metadata = result.tokens.map(registryTokenToCreatedToken);
        snapshot.current = result.asOfBlock;
        setPage(result);
        setTokens(metadata);
        setLoading(false);
        if (!readOnly) {
          const balances = await enrichBalances(
            client,
            config,
            metadata,
            controller.signal,
          );
          if (!controller.signal.aborted) setTokens(balances);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            userErrorMessage(reason, "The token registry is unavailable"),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          busy.current = false;
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [
    config,
    client,
    query,
    sort,
    offset,
    refreshKey,
    scope,
    readOnly,
    registryRead,
    enrichBalances,
  ]);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll(hint = false) {
      if (
        stopped ||
        inFlight ||
        (!hint && document.visibilityState !== "visible")
      )
        return;
      inFlight = true;
      clearTimeout(timer);
      let syncing = false;
      try {
        const result = hint
          ? await registrySync(config, controller.signal)
          : await registryStatus(config, controller.signal);
        if (stopped) return;
        setStatus(result);
        setStatusError(false);
        syncing = result.syncing;
        if (!syncing && !busy.current) {
          if (offset === 0) snapshot.current = undefined;
          setRefreshKey((value) => value + 1);
        }
      } catch {
        if (!stopped) setStatusError(true);
      } finally {
        inFlight = false;
        if (!stopped)
          timer = setTimeout(() => void poll(), syncing ? 1_000 : 15_000);
      }
    }
    const visible = () => void poll();
    void poll(true);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [config, registryStatus, registrySync, offset]);

  return {
    search,
    sort,
    offset,
    page,
    tokens,
    status,
    statusError,
    error,
    loading,
    setSearch,
    setSort(value: RegistrySort) {
      invalidate();
      setSort(value);
    },
    changePage(value: number) {
      request.current?.abort();
      setOffset(value);
    },
    refresh() {
      request.current?.abort();
      setRefreshKey((value) => value + 1);
    },
  };
}
