/** One token from the Launchpad indexer's `GET /api/tokens`. */
export interface IndexedToken {
  address: string;
  creator: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  initialSupply: string;
  blockHeight: string;
  transactionHash: string;
}

export interface TokenPage {
  tokens: IndexedToken[];
  hasMore: boolean;
  /** The block this listing stops at; send it back for the next pages. */
  asOfBlock: string | null;
  /** The last block the indexer has read, or null before its first pass. */
  indexedThrough: string | null;
}

export interface TokenQuery {
  q?: string;
  creator?: string;
  limit: number;
  offset: number;
  asOfBlock?: string;
}

/** Read one page of tokens from the app's own indexer, newest first. */
export async function fetchTokens(
  query: TokenQuery,
  signal?: AbortSignal,
): Promise<TokenPage> {
  const params = new URLSearchParams({
    limit: String(query.limit),
    offset: String(query.offset),
  });
  if (query.q) params.set("q", query.q);
  if (query.creator) params.set("creator", query.creator);
  if (query.asOfBlock) params.set("asOfBlock", query.asOfBlock);
  const response = await fetch(
    `${import.meta.env.BASE_URL}api/tokens?${params}`,
    { cache: "no-store", ...(signal ? { signal } : {}) },
  );
  const body = (await response.json()) as TokenPage;
  if (!response.ok || !Array.isArray(body.tokens))
    throw new Error("The token list is unavailable. Try again.");
  return body;
}
