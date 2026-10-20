import { useEffect, useMemo, useRef, useState } from "react";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import { getClientQueryKey, useClient } from "@thruputchain/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GlobalConfig } from "@/config";
import { typedAddress } from "@/lib/address";
import {
  getRegistryPools,
  getPoolRegistryStatus,
  requestPoolRegistrySync,
  type RegistrySort,
} from "@/registry/client";
import {
  enrichRegistryPools,
  registryPoolsToEntries,
  type RegistryPoolEntry,
} from "@/registry/pools";

export const DIRECTORY_REFRESH_INTERVAL_MS = 15_000;

export function usePoolDirectory({
  config,
  read,
  readStatus,
  requestSync,
  enrich,
}: {
  config: GlobalConfig;
  read: typeof getRegistryPools;
  readStatus: typeof getPoolRegistryStatus;
  requestSync: typeof requestPoolRegistrySync;
  enrich: typeof enrichRegistryPools;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const [search, setSearch] = useState("");
  const [token, setToken] = useState("");
  const [filters, setFilters] = useState({ search: "", token: "" });
  const [sort, setSort] = useState<RegistrySort>("newest");
  const [pagination, setPagination] = useState<{
    offset: number;
    asOfBlock?: string;
  }>({ offset: 0 });
  const [syncRevision, setSyncRevision] = useState(0);
  const lastStatus = useRef(0);
  const factory = toBase58(config.factoryAddress);
  const account = toBase58(config.accountAddress);
  const networkId = config.networkId;
  const registry = useMemo(
    () => ({ networkId, factoryAddress: addressFromBase58(factory) }),
    [networkId, factory],
  );
  const prefix = useMemo(
    () => ["pool-registry", registry.networkId, factory],
    [registry, factory],
  );
  const statusKey = useMemo(
    () => [...prefix, "status", syncRevision],
    [prefix, syncRevision],
  );
  const pageKey = useMemo(
    () => [...prefix, "page", filters, sort, pagination],
    [prefix, filters, sort, pagination],
  );
  // The token filter is an exact address: base58 or C StrKey, sent as base58.
  const tokenFilter = filters.token.trim() ? typedAddress(filters.token) : null;
  const tokenError =
    token.trim() && typedAddress(token) === null
      ? /^0x/i.test(token.trim())
        ? "Enter the base58 token address. 0x hex addresses are not accepted."
        : "Enter a complete base58 token address."
      : null;
  // Search matches address substrings. A whole address (base58 or C StrKey)
  // is searched as base58; base58 has no "0", so 0x hex can never match.
  const searchText = filters.search.trim();
  const searchQuery = searchText
    ? (typedAddress(searchText) ?? searchText)
    : null;
  const searchError = /^0x/i.test(search.trim())
    ? "Search with base58 address text. 0x hex addresses are not accepted."
    : null;
  useEffect(() => {
    if (search === filters.search && token === filters.token) return;
    const timer = setTimeout(() => {
      setPagination({ offset: 0 });
      setFilters({ search, token });
    }, 300);
    return () => clearTimeout(timer);
  }, [search, token, filters]);
  const page = useQuery({
    queryKey: pageKey,
    queryFn: ({ signal }) =>
      read(
        registry,
        {
          ...(searchQuery === null ? {} : { q: searchQuery }),
          ...(tokenFilter === null ? {} : { token: tokenFilter }),
          sort,
          limit: 20,
          ...pagination,
        },
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      ),
    enabled:
      (!filters.token.trim() || tokenFilter !== null) &&
      !/^0x/i.test(searchText),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const sourceKey = useMemo(() => getClientQueryKey(client), [client]);
  const liveKey = useMemo(
    () => [
      ...sourceKey,
      "pool-directory",
      account,
      factory,
      page.data?.pools ?? null,
    ],
    [sourceKey, account, factory, page.data?.pools],
  );
  const live = useQuery({
    queryKey: liveKey,
    enabled: page.data !== undefined,
    queryFn: async ({ signal }) => {
      const initial = registryPoolsToEntries(page.data!.pools);
      const previous = queries.getQueryData<RegistryPoolEntry[]>(liveKey) ?? [];
      try {
        const result = await enrich(config, initial, client, signal);
        signal.throwIfAborted();
        return retainLiveData(result, previous);
      } catch (error) {
        signal.throwIfAborted();
        return retainLiveData(
          initial.map((entry) => ({
            ...entry,
            loading: false,
            readError: true,
          })),
          previous,
        );
      }
    },
    placeholderData: (previous, previousQuery) =>
      page.data &&
      previousQuery?.queryKey[2] === sourceKey[2] &&
      previousQuery.queryKey[4] === account &&
      previousQuery.queryKey[5] === factory
        ? retainLiveData(
            registryPoolsToEntries(page.data.pools),
            previous ?? [],
          )
        : undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const readFreshness = useMemo(() => {
    let first = true;
    return async (signal: AbortSignal) => {
      if (first) {
        first = false;
        try {
          return await requestSync(registry, signal);
        } catch {
          signal.throwIfAborted();
        }
      }
      return readStatus(registry, signal);
    };
  }, [registry, requestSync, readStatus, syncRevision]);
  const status = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) =>
      readFreshness(AbortSignal.any([signal, AbortSignal.timeout(10_000)])),
    refetchInterval: (query) =>
      query.state.status === "error" || query.state.data?.syncing
        ? 1_000
        : DIRECTORY_REFRESH_INTERVAL_MS,
    retry: false,
  });
  const statusVersion = queries.getQueryState(statusKey)?.dataUpdateCount ?? 0;
  const pageVersion = queries.getQueryState(pageKey)?.dataUpdateCount ?? 0;
  // A completed status poll refreshes the current page, never an overlapping read.
  // Counters also distinguish two completions in the same millisecond.
  useEffect(() => {
    if (status.isFetching) return;
    const previous = lastStatus.current;
    lastStatus.current = statusVersion;
    if (!previous || previous === statusVersion) return;
    if (
      document.visibilityState === "visible" &&
      status.dataUpdatedAt &&
      !status.data?.syncing &&
      !queries.isFetching({ queryKey: [...prefix, "page"] }) &&
      !queries.isFetching({ queryKey: [...sourceKey, "pool-directory"] })
    ) {
      if (pagination.offset === 0 && pagination.asOfBlock !== undefined)
        setPagination({ offset: 0 });
      else void queries.invalidateQueries({ queryKey: [...prefix, "page"] });
    }
  }, [
    statusVersion,
    status.isFetching,
    status.data?.syncing,
    queries,
    prefix,
    sourceKey,
    pagination,
  ]);
  useEffect(() => {
    if (pageVersion > 1 && !queries.isFetching({ queryKey: liveKey }))
      void queries.invalidateQueries({ queryKey: liveKey, exact: true });
  }, [pageVersion, liveKey, queries]);

  return {
    search,
    setSearch,
    searchError,
    token,
    setToken,
    tokenError,
    sort,
    setSort,
    offset: pagination.offset,
    page: page.data ?? null,
    entries:
      live.data ?? (page.data ? registryPoolsToEntries(page.data.pools) : []),
    status: status.data ?? null,
    statusError: status.isError,
    error: page.error?.message ?? null,
    loading: page.isFetching,
    hasFilters: !!filters.search.trim() || !!filters.token.trim(),
    resetSnapshot() {
      setPagination({ offset: 0 });
    },
    async refresh() {
      lastStatus.current = 0;
      await queries.cancelQueries({ queryKey: prefix });
      await queries.cancelQueries({
        queryKey: [...sourceKey, "pool-directory"],
      });
      setPagination({ offset: 0 });
      setSyncRevision((value) => value + 1);
      void queries.invalidateQueries({ queryKey: [...prefix, "page"] });
      void queries.invalidateQueries({
        queryKey: [...sourceKey, "pool-directory"],
      });
    },
    changePage(offset: number) {
      setPagination({
        offset,
        ...(page.data ? { asOfBlock: page.data.asOfBlock } : {}),
      });
    },
  };
}

function retainLiveData(
  entries: RegistryPoolEntry[],
  previous: RegistryPoolEntry[],
): RegistryPoolEntry[] {
  return entries.map((entry) => ({
    ...entry,
    live:
      entry.live ??
      previous.find(
        (old) => old.record.handlerAddress === entry.record.handlerAddress,
      )?.live ??
      null,
  }));
}
