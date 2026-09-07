export const MAX_DISCOVERY_RESPONSE_BYTES = 256_000;

export interface DiscoveryScope {
  networkId: string;
  factoryAddress: string;
  tokenCodeHash: string;
}

export interface DiscoveryToken {
  tokenAddress: string;
  creatorAddress: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

export interface DiscoveryResponse {
  scope: DiscoveryScope;
  tokens: DiscoveryToken[];
  hasMore: boolean;
  historyLimited: boolean;
  syncState: "idle" | "syncing" | "retrying";
}

export function record(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (keys &&
      (Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))))
  ) {
    throw new Error("Invalid discovery response");
  }
  return value as Record<string, unknown>;
}

export function validateScope(
  value: unknown,
  expected: DiscoveryScope,
): DiscoveryScope {
  const scope = record(value);
  if (
    typeof scope.networkId !== "string" ||
    scope.networkId.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(scope.networkId) ||
    !canonicalAddress(scope.factoryAddress) ||
    scope.factoryAddress === `0x${"0".repeat(64)}` ||
    !canonicalAddress(scope.tokenCodeHash) ||
    scope.networkId !== expected.networkId ||
    scope.factoryAddress !== expected.factoryAddress ||
    scope.tokenCodeHash !== expected.tokenCodeHash
  )
    throw new Error("Invalid discovery scope");
  return {
    networkId: scope.networkId,
    factoryAddress: scope.factoryAddress,
    tokenCodeHash: scope.tokenCodeHash,
  };
}

export function projectToken(value: unknown): DiscoveryToken {
  const token = record(value);
  if (
    !canonicalAddress(token.tokenAddress) ||
    token.tokenAddress === `0x${"0".repeat(64)}` ||
    !canonicalAddress(token.creatorAddress) ||
    !nullableText(token.name, 256) ||
    !nullableText(token.symbol, 64) ||
    !(
      token.decimals === null ||
      (typeof token.decimals === "number" &&
        Number.isInteger(token.decimals) &&
        token.decimals >= 0 &&
        token.decimals <= 255)
    )
  ) {
    throw new Error("Invalid discovery token");
  }
  return {
    tokenAddress: token.tokenAddress,
    creatorAddress: token.creatorAddress,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
  };
}

export function validateDiscoveryResponse(
  value: unknown,
  expected: DiscoveryScope,
): DiscoveryResponse {
  const page = record(value, [
    "scope",
    "tokens",
    "hasMore",
    "historyLimited",
    "syncState",
  ]);
  record(page.scope, ["networkId", "factoryAddress", "tokenCodeHash"]);
  const scope = validateScope(page.scope, expected);
  if (
    !Array.isArray(page.tokens) ||
    page.tokens.length > 20 ||
    typeof page.hasMore !== "boolean" ||
    typeof page.historyLimited !== "boolean" ||
    (page.syncState !== "idle" &&
      page.syncState !== "syncing" &&
      page.syncState !== "retrying") ||
    (page.hasMore && page.tokens.length !== 20)
  )
    throw new Error("Invalid discovery page");
  const tokens = page.tokens.map((value) =>
    projectToken(
      record(value, [
        "tokenAddress",
        "creatorAddress",
        "name",
        "symbol",
        "decimals",
      ]),
    ),
  );
  if (new Set(tokens.map((token) => token.tokenAddress)).size !== tokens.length)
    throw new Error("Duplicate discovery token");
  return {
    scope,
    tokens,
    hasMore: page.hasMore,
    historyLimited: page.historyLimited,
    syncState: page.syncState,
  };
}

export function discoveryQuery(value: string): string {
  const query = value.trim();
  if (new TextEncoder().encode(query).byteLength > 100)
    throw new Error("Search must contain at most 100 UTF-8 bytes");
  return query;
}

export async function readDiscoveryJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    !response.ok ||
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    (declared !== null &&
      (!/^\d+$/.test(declared) ||
        Number(declared) > MAX_DISCOVERY_RESPONSE_BYTES))
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid discovery response");
  }
  if (!response.body) throw new Error("Empty discovery response");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DISCOVERY_RESPONSE_BYTES) {
        throw new Error("Discovery response is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function canonicalAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 66 &&
    /^0x[0-9a-f]{64}$/.test(value)
  );
}

function nullableText(value: unknown, maximum: number): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      new TextEncoder().encode(value).byteLength <= maximum)
  );
}
