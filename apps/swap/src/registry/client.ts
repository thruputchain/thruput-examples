import { toBase58 } from "@thruputchain/client";

import type { GlobalConfig } from "@/config";
import { isBase58Identifier } from "@/lib/address";
import {
  inCanonicalTokenOrder,
  ZERO_ADDRESS,
  REGISTRY_SORTS as SORTS,
  REGISTRY_SYNC_STATES as SYNC_STATES,
  type RegistrySort,
  type RegistrySyncState,
  type RegistryPool,
  type RegistryStatus,
  type PoolQueryResult as RegistryPoolPage,
  type PoolQuery as RegistryPoolQuery,
} from "../../shared/registry";
export type {
  RegistrySort,
  RegistrySyncState,
  RegistryPool,
  RegistryStatus,
  RegistryPoolPage,
  RegistryPoolQuery,
};

const DECIMAL = /^(?:0|[1-9]\d*)$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_DECIMAL_DIGITS = 100;
const U32_MAX = 0xffff_ffffn;

type RegistryConfig = Pick<GlobalConfig, "networkId" | "factoryAddress">;
type Fetcher = typeof globalThis.fetch;

export class RegistryClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryClientError";
  }
}

export async function getRegistryPools(
  config: RegistryConfig,
  query: RegistryPoolQuery,
  signal?: AbortSignal,
  fetcher: Fetcher = globalThis.fetch,
): Promise<RegistryPoolPage> {
  const normalized = validateQuery(query);
  const parameters = new URLSearchParams({
    sort: query.sort,
    limit: query.limit.toString(),
    offset: query.offset.toString(),
  });
  if (normalized.q !== undefined) parameters.set("q", normalized.q);
  if (normalized.token !== undefined) parameters.set("token", normalized.token);
  if (query.asOfBlock !== undefined)
    parameters.set("asOfBlock", query.asOfBlock);
  const value = await requestJson(
    `/api/pools?${parameters.toString()}`,
    requestInit("GET", signal),
    fetcher,
  );
  return validatePoolPage(value, config, { ...query, ...normalized });
}

export async function getPoolRegistryStatus(
  config: RegistryConfig,
  signal?: AbortSignal,
  fetcher: Fetcher = globalThis.fetch,
): Promise<RegistryStatus> {
  return validateStatus(
    await requestJson(
      "/api/registry/status",
      requestInit("GET", signal),
      fetcher,
    ),
    config,
  );
}

export async function requestPoolRegistrySync(
  config: RegistryConfig,
  signal?: AbortSignal,
  fetcher: Fetcher = globalThis.fetch,
): Promise<RegistryStatus> {
  return validateStatus(
    await requestJson(
      "/api/registry/sync",
      requestInit("POST", signal),
      fetcher,
    ),
    config,
  );
}

function requestInit(
  method: "GET" | "POST",
  signal?: AbortSignal,
): RequestInit {
  return { method, ...(signal === undefined ? {} : { signal }) };
}

async function requestJson(
  path: string,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<unknown> {
  const response = await fetcher(path, init);
  if (!response.ok) {
    throw new RegistryClientError(
      `Registry request failed (${response.status}). Try again.`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.startsWith("application/json")) {
    throw new RegistryClientError("Registry returned an invalid response");
  }
  const bytes = await readBoundedBody(response);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryClientError("Registry returned invalid JSON");
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    throw new RegistryClientError("Registry response is too large");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RegistryClientError("Registry response is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validatePoolPage(
  value: unknown,
  config: RegistryConfig,
  query: RegistryPoolQuery,
): RegistryPoolPage {
  const record = object(value, "pool page");
  exactKeys(
    record,
    [
      "networkId",
      "factoryAddress",
      "pools",
      "total",
      "limit",
      "offset",
      "asOfBlock",
      "hasMore",
      "historyLimited",
    ],
    "pool page",
  );
  const scope = validateScope(record, config, "pool page");
  const limit = integer(record.limit, "limit", 1, 100);
  const offset = integer(record.offset, "offset", 0, 10_000);
  if (limit !== query.limit || offset !== query.offset) invalid("pagination");
  if (!Array.isArray(record.pools)) invalid("pools");
  const total = integer(record.total, "total", 0, Number.MAX_SAFE_INTEGER);
  const expectedLength = Math.min(limit, Math.max(0, total - offset));
  if (record.pools.length !== expectedLength) invalid("pools");
  const pools = record.pools.map((pool, index) =>
    validatePool(pool, config, `pools[${index}]`),
  );
  const asOfBlock = decimal(record.asOfBlock, "asOfBlock");
  if (query.asOfBlock !== undefined && asOfBlock !== query.asOfBlock)
    invalid("asOfBlock");
  if (pools.some((pool) => compareDecimal(pool.createdBlock, asOfBlock) > 0)) {
    invalid("pool created block");
  }
  if (
    query.token !== undefined &&
    pools.some(
      (pool) =>
        pool.token0Address !== query.token &&
        pool.token1Address !== query.token,
    )
  )
    invalid("token filter");
  if (query.q !== undefined) {
    // Matches the server: NFKC-normalized, exact (base58 is case-sensitive).
    const search = query.q.normalize("NFKC").trim();
    if (
      pools.some(
        (pool) =>
          ![
            pool.token0Address,
            pool.token1Address,
            pool.liquidityTokenAddress,
            pool.handlerAddress,
            pool.driverAddress,
          ].some((candidate) => candidate.includes(search)),
      )
    )
      invalid("search result");
  }
  unique(
    pools,
    (pool) => `${pool.token0Address}:${pool.token1Address}`,
    "duplicate pair",
  );
  unique(
    pools,
    (pool) => `${pool.transactionHash}:${pool.eventSequence}`,
    "duplicate event",
  );
  unique(
    pools,
    (pool) => pool.liquidityTokenAddress,
    "duplicate liquidity token",
  );
  unique(pools, (pool) => pool.handlerAddress, "duplicate handler");
  unique(pools, (pool) => pool.driverAddress, "duplicate driver");
  unique(pools, (pool) => pool.pairCount, "duplicate pairCount");
  for (let index = 1; index < pools.length; index += 1) {
    if (comparePools(pools[index - 1]!, pools[index]!, query.sort) > 0)
      invalid("sort order");
  }
  if (pools.length > Math.max(0, total - offset)) invalid("total");
  const hasMore = boolean(record.hasMore, "hasMore");
  if (hasMore !== offset + pools.length < total) invalid("hasMore");
  return {
    ...scope,
    pools,
    total,
    limit,
    offset,
    asOfBlock,
    hasMore,
    historyLimited: boolean(record.historyLimited, "historyLimited"),
  };
}

function validatePool(
  value: unknown,
  config: RegistryConfig,
  name: string,
): RegistryPool {
  const record = object(value, name);
  exactKeys(
    record,
    [
      "networkId",
      "factoryAddress",
      "token0Address",
      "token1Address",
      "liquidityTokenAddress",
      "handlerAddress",
      "driverAddress",
      "pairCount",
      "transactionHash",
      "eventSequence",
      "createdBlock",
      "indexedAt",
    ],
    name,
  );
  const scope = validateScope(record, config, name);
  const token0Address = nonzeroAddress(
    record.token0Address,
    `${name}.token0Address`,
  );
  const token1Address = nonzeroAddress(
    record.token1Address,
    `${name}.token1Address`,
  );
  if (!inCanonicalTokenOrder(token0Address, token1Address))
    invalid(`${name}.token pair`);
  const liquidityTokenAddress = nonzeroAddress(
    record.liquidityTokenAddress,
    `${name}.liquidityTokenAddress`,
  );
  const handlerAddress = nonzeroAddress(
    record.handlerAddress,
    `${name}.handlerAddress`,
  );
  const driverAddress = nonzeroAddress(
    record.driverAddress,
    `${name}.driverAddress`,
  );
  if (
    new Set([liquidityTokenAddress, handlerAddress, driverAddress]).size !== 3
  ) {
    invalid(`${name}.child addresses`);
  }
  const pairCount = decimal(record.pairCount, `${name}.pairCount`);
  if (pairCount === "0" || BigInt(pairCount) > U32_MAX)
    invalid(`${name}.pairCount`);
  const eventSequence = decimal(record.eventSequence, `${name}.eventSequence`);
  if (BigInt(eventSequence) > U32_MAX) invalid(`${name}.eventSequence`);
  const createdBlock = decimal(record.createdBlock, `${name}.createdBlock`);
  if (createdBlock === "0") invalid(`${name}.createdBlock`);
  return {
    ...scope,
    token0Address,
    token1Address,
    liquidityTokenAddress,
    handlerAddress,
    driverAddress,
    pairCount,
    transactionHash: hash(record.transactionHash, `${name}.transactionHash`),
    eventSequence,
    createdBlock,
    indexedAt: timestamp(record.indexedAt, `${name}.indexedAt`),
  };
}

function validateStatus(
  value: unknown,
  config: RegistryConfig,
): RegistryStatus {
  const record = object(value, "registry status");
  exactKeys(
    record,
    [
      "networkId",
      "factoryAddress",
      "indexedThroughBlock",
      "poolCount",
      "historyLimited",
      "syncState",
      "syncing",
      "lastSuccessfulSyncAt",
      "lastError",
    ],
    "registry status",
  );
  const scope = validateScope(record, config, "registry status");
  const syncState = enumeration(record.syncState, SYNC_STATES, "syncState");
  const syncing = boolean(record.syncing, "syncing");
  if (syncing !== (syncState === "syncing" || syncState === "retrying"))
    invalid("syncing");
  return {
    ...scope,
    indexedThroughBlock: decimal(
      record.indexedThroughBlock,
      "indexedThroughBlock",
    ),
    poolCount: integer(
      record.poolCount,
      "poolCount",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    historyLimited: boolean(record.historyLimited, "historyLimited"),
    syncState,
    syncing,
    lastSuccessfulSyncAt:
      record.lastSuccessfulSyncAt === null
        ? null
        : timestamp(record.lastSuccessfulSyncAt, "lastSuccessfulSyncAt"),
    lastError: nullableText(record.lastError, "lastError", 500),
  };
}

function validateScope(
  record: Record<string, unknown>,
  config: RegistryConfig,
  name: string,
): Pick<RegistryPool, "networkId" | "factoryAddress"> {
  const networkId = network(record.networkId, `${name}.networkId`);
  const factoryAddress = address(
    record.factoryAddress,
    `${name}.factoryAddress`,
  );
  if (
    networkId !== config.networkId ||
    factoryAddress !== toBase58(config.factoryAddress)
  ) {
    throw new RegistryClientError(
      "Registry response has a different chain scope",
    );
  }
  return { networkId, factoryAddress };
}

function validateQuery(
  query: RegistryPoolQuery,
): Pick<RegistryPoolQuery, "q" | "token"> {
  enumeration(query.sort, SORTS, "sort");
  integer(query.limit, "limit", 1, 100);
  integer(query.offset, "offset", 0, 10_000);
  const q = query.q?.normalize("NFKC").trim();
  if (q !== undefined && new TextEncoder().encode(q).byteLength > 100)
    invalid("q");
  const token =
    query.token === undefined ? undefined : address(query.token, "token");
  if (query.asOfBlock !== undefined) decimal(query.asOfBlock, "asOfBlock");
  return {
    ...(q === undefined || q === "" ? {} : { q }),
    ...(token === undefined ? {} : { token }),
  };
}

function comparePools(
  left: RegistryPool,
  right: RegistryPool,
  sort: RegistrySort,
): number {
  if (sort === "token0")
    return (
      compareText(left.token0Address, right.token0Address) ||
      compareText(left.token1Address, right.token1Address) ||
      compareDecimal(left.createdBlock, right.createdBlock) ||
      compareDecimal(left.eventSequence, right.eventSequence)
    );
  if (sort === "token1")
    return (
      compareText(left.token1Address, right.token1Address) ||
      compareText(left.token0Address, right.token0Address) ||
      compareDecimal(left.createdBlock, right.createdBlock) ||
      compareDecimal(left.eventSequence, right.eventSequence)
    );
  const direction = sort === "newest" ? -1 : 1;
  return (
    direction *
      (compareDecimal(left.createdBlock, right.createdBlock) ||
        compareDecimal(left.eventSequence, right.eventSequence)) ||
    compareText(left.token0Address, right.token0Address) ||
    compareText(left.token1Address, right.token1Address)
  );
}

function unique<T>(
  values: readonly T[],
  key: (value: T) => string,
  name: string,
): void {
  if (new Set(values.map(key)).size !== values.length) invalid(name);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(name);
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !expected.has(key))
  ) {
    invalid(name);
  }
}

function address(value: unknown, name: string): string {
  if (!isBase58Identifier(value)) invalid(name);
  return value;
}

function nonzeroAddress(value: unknown, name: string): string {
  const result = address(value, name);
  if (result === ZERO_ADDRESS) invalid(name);
  return result;
}

function hash(value: unknown, name: string): string {
  if (!isBase58Identifier(value)) invalid(name);
  return value;
}

function network(value: unknown, name: string): string {
  if (!isBase58Identifier(value)) invalid(name);
  return value;
}

function decimal(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_DECIMAL_DIGITS ||
    !DECIMAL.test(value)
  )
    invalid(name);
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(name);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") invalid(name);
  return value;
}

function nullableText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  )
    invalid(name);
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 30) invalid(name);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value)
    invalid(name);
  return value;
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(name);
  return value;
}

function invalid(name: string): never {
  throw new RegistryClientError(`Registry returned an invalid ${name}`);
}

function compareDecimal(left: string, right: string): number {
  return left.length === right.length
    ? compareText(left, right)
    : left.length - right.length;
}

// Display sorts order addresses by their base58 text, as the server's SQLite
// does. Pool token pairs are ordered by address bytes instead.
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
