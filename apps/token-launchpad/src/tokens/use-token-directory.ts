import { toBase58 } from "@thruputchain/client";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AppConfig } from "@/config";
import { userErrorMessage } from "@/lib/errors";
import { fetchTokens } from "./api";

export const PAGE_SIZE = 20;

export interface DirectoryOptions {
  config: AppConfig;
  scope: "all" | "mine";
  readOnly?: boolean;
  read?: typeof fetchTokens;
}

/** Search and page through the tokens the indexer has saved. */
export function useTokenDirectory({
  config,
  scope,
  read = fetchTokens,
}: DirectoryOptions) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  // The block the first page stopped at. Later pages list up to it, so new
  // launches do not shift them; the first page shows new launches as usual.
  const [asOfBlock, setAsOfBlock] = useState<string | null>(null);
  const creator = scope === "mine" ? toBase58(config.accountAddress) : undefined;

  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      setQuery(search.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const page = useQuery({
    queryKey: [
      "tokens",
      config.networkId,
      creator,
      query,
      offset,
      offset === 0 ? null : asOfBlock,
    ],
    queryFn: ({ signal }) =>
      read(
        {
          ...(query ? { q: query } : {}),
          ...(creator ? { creator } : {}),
          limit: PAGE_SIZE,
          offset,
          ...(offset > 0 && asOfBlock ? { asOfBlock } : {}),
        },
        signal,
      ),
    placeholderData: keepPreviousData,
    // The indexer reads new blocks every few seconds.
    refetchInterval: 5_000,
    retry: false,
  });

  useEffect(() => {
    if (offset === 0 && page.data && !page.isPlaceholderData)
      setAsOfBlock(page.data.asOfBlock);
  }, [offset, page.data, page.isPlaceholderData]);

  return {
    search,
    setSearch,
    offset,
    setOffset,
    page: page.data ?? null,
    loading: page.isFetching,
    error: page.error
      ? userErrorMessage(page.error, "The token list is unavailable")
      : null,
    refresh: () => void page.refetch(),
  };
}
