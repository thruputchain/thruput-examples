import { toHex0x } from "@thruputchain/client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AppConfig } from "@/config";
import { userErrorMessage } from "@/lib/errors";
import {
  getRegistryStatus,
  getRegistryTokens,
  requestRegistrySync,
  type RegistrySort,
} from "@/registry/client";
import { registryTokenToCreatedToken } from "@/registry/tokens";

export interface DirectoryOptions {
  config: AppConfig;
  scope: "all" | "mine";
  readOnly?: boolean;
  registryRead?: typeof getRegistryTokens;
  registryStatus?: typeof getRegistryStatus;
  registrySync?: typeof requestRegistrySync;
}

export function useTokenDirectory({
  config,
  scope,
  registryRead = getRegistryTokens,
  registryStatus = getRegistryStatus,
  registrySync = requestRegistrySync,
}: DirectoryOptions) {
  const queries = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RegistrySort>("newest");
  const [pagination, setPagination] = useState<{
    offset: number;
    asOfBlock?: string;
  }>({ offset: 0 });
  const lastStatus = useRef(0);
  const prefix = useMemo(
    () => [
      "token-registry",
      config.networkIdHex,
      toHex0x(config.factoryAddress),
      toHex0x(config.expectedTokenHash),
    ],
    [config],
  );
  const statusKey = useMemo(() => [...prefix, "status"], [prefix]);
  const pageKey = useMemo(
    () => [
      ...prefix,
      "page",
      scope === "mine" ? toHex0x(config.accountAddress) : null,
      query,
      sort,
      pagination,
    ],
    [prefix, scope, config.accountAddress, query, sort, pagination],
  );

  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setPagination({ offset: 0 });
      setQuery(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, query]);

  const page = useQuery({
    queryKey: pageKey,
    queryFn: ({ signal }) =>
      registryRead(
        config,
        {
          ...(query ? { q: query } : {}),
          ...(scope === "mine"
            ? { creator: toHex0x(config.accountAddress) }
            : {}),
          sort,
          limit: 20,
          ...pagination,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
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
          return await registrySync(config, signal);
        } catch {
          signal.throwIfAborted();
        }
      }
      return registryStatus(config, signal);
    };
  }, [config, registrySync, registryStatus]);
  const status = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) => readFreshness(signal),
    refetchInterval: (query) => (query.state.data?.syncing ? 1_000 : 15_000),
    retry: false,
  });
  const statusVersion = queries.getQueryState(statusKey)?.dataUpdateCount ?? 0;
  useEffect(() => {
    if (status.isFetching) return;
    const previous = lastStatus.current;
    lastStatus.current = statusVersion;
    if (!previous || previous === statusVersion) return;
    if (
      document.visibilityState === "visible" &&
      status.dataUpdatedAt &&
      !status.data?.syncing &&
      !queries.isFetching({ queryKey: pageKey })
    ) {
      if (pagination.offset === 0 && pagination.asOfBlock !== undefined)
        setPagination({ offset: 0 });
      else void queries.invalidateQueries({ queryKey: pageKey, exact: true });
    }
  }, [
    statusVersion,
    status.isFetching,
    status.data?.syncing,
    queries,
    pageKey,
    pagination,
  ]);

  return {
    search,
    sort,
    offset: pagination.offset,
    page: page.data ?? null,
    tokens: (page.data?.tokens ?? []).map(registryTokenToCreatedToken),
    status: status.data ?? null,
    statusError: status.isError,
    error: page.error
      ? userErrorMessage(page.error, "The token registry is unavailable")
      : null,
    loading: page.isFetching,
    setSearch,
    setSort(value: RegistrySort) {
      setPagination({ offset: 0 });
      setSort(value);
    },
    changePage(offset: number) {
      setPagination({
        offset,
        ...(page.data ? { asOfBlock: page.data.asOfBlock } : {}),
      });
    },
    refresh() {
      void page.refetch();
    },
  };
}
