import { toHex0x } from "@groundhogchain/client";

import type { AppConfig } from "@/config";
import { MAX_SIGNED_AMOUNT } from "@/runtime";
import { REGISTRY_SORTS as SORTS, REGISTRY_SYNC_STATES as SYNC_STATES,
  type RegistrySort, type RegistrySyncState, type RegistryToken, type RegistryStatus,
  type TokenQueryResult as RegistryTokenPage, type TokenQuery,
} from "../../shared/registry";
export type { RegistrySort, RegistrySyncState, RegistryToken, RegistryStatus, RegistryTokenPage };
export type RegistryTokenQuery = Omit<TokenQuery, "tokenAddress">;

const ADDRESS = /^0x[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const NETWORK_ID = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_DECIMAL_DIGITS = 100;

type RegistryConfig = Pick<
  AppConfig,
  "networkIdHex" | "factoryAddress" | "expectedTokenHash"
>;
type Fetcher = typeof globalThis.fetch;

export class RegistryClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryClientError";
  }
}

export async function getRegistryTokens(
  config: RegistryConfig,
  query: RegistryTokenQuery,
  signal?: AbortSignal,
  fetcher: Fetcher = globalThis.fetch,
): Promise<RegistryTokenPage> {
  validateQuery(query);
  const parameters = new URLSearchParams({
    sort: query.sort,
    limit: query.limit.toString(),
    offset: query.offset.toString(),
  });
  if (query.q !== undefined && query.q.trim() !== "") {
    parameters.set("q", query.q.trim());
  }
  if (query.creator !== undefined) parameters.set("creator", query.creator);
  if (query.asOfBlock !== undefined) {
    parameters.set("asOfBlock", query.asOfBlock);
  }
  const value = await requestJson(
    `/api/tokens?${parameters.toString()}`,
    requestInit("GET", signal),
    fetcher,
  );
  return validateTokenPage(value, config, query);
}

export async function getRegistryStatus(
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

export async function requestRegistrySync(
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
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
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

function validateTokenPage(
  value: unknown,
  config: RegistryConfig,
  query: RegistryTokenQuery,
): RegistryTokenPage {
  const record = object(value, "token page");
  const limit = integer(record.limit, "limit", 1, 100);
  const offset = integer(record.offset, "offset", 0, 10_000);
  if (limit !== query.limit || offset !== query.offset) invalid("pagination");
  if (!Array.isArray(record.tokens) || record.tokens.length > limit) {
    invalid("tokens");
  }
  const total = integer(record.total, "total", 0, Number.MAX_SAFE_INTEGER);
  const tokens = record.tokens.map((token, index) =>
    validateToken(token, config, `tokens[${index}]`),
  );
  if (
    query.creator !== undefined &&
    tokens.some((token) => token.creatorAddress !== query.creator)
  ) {
    invalid("creator filter");
  }
  if (
    new Set(tokens.map((token) => token.tokenAddress)).size !== tokens.length
  ) {
    invalid("duplicate token address");
  }
  const asOfBlock = decimal(record.asOfBlock, "asOfBlock");
  if (query.asOfBlock !== undefined && asOfBlock !== query.asOfBlock) {
    invalid("asOfBlock");
  }
  if (
    tokens.some((token) => compareDecimal(token.blockHeight, asOfBlock) > 0)
  ) {
    invalid("token block height");
  }
  if (tokens.length > Math.max(0, total - offset)) invalid("total");
  const hasMore = boolean(record.hasMore, "hasMore");
  if (hasMore !== offset + tokens.length < total) invalid("hasMore");
  return {
    tokens,
    total,
    limit,
    offset,
    asOfBlock,
    hasMore,
    historyLimited: boolean(record.historyLimited, "historyLimited"),
  };
}

function validateToken(
  value: unknown,
  config: RegistryConfig,
  name: string,
): RegistryToken {
  const record = object(value, name);
  const networkId = network(record.networkId, `${name}.networkId`);
  const factoryAddress = address(
    record.factoryAddress,
    `${name}.factoryAddress`,
  );
  const tokenCodeHash = hash(record.tokenCodeHash, `${name}.tokenCodeHash`);
  if (
    networkId !== config.networkIdHex ||
    factoryAddress !== toHex0x(config.factoryAddress) ||
    tokenCodeHash !== toHex0x(config.expectedTokenHash)
  ) {
    throw new RegistryClientError(
      "Registry response has a different chain scope",
    );
  }
  const initialSupply = decimal(record.initialSupply, `${name}.initialSupply`);
  if (BigInt(initialSupply) > MAX_SIGNED_AMOUNT)
    invalid(`${name}.initialSupply`);
  const decimals = nullableInteger(
    record.decimals,
    `${name}.decimals`,
    0,
    0xffff_ffff,
  );
  return {
    networkId,
    factoryAddress,
    tokenAddress: address(record.tokenAddress, `${name}.tokenAddress`),
    creatorAddress: address(record.creatorAddress, `${name}.creatorAddress`),
    administratorAddress: address(
      record.administratorAddress,
      `${name}.administratorAddress`,
    ),
    initialHolderAddress: address(
      record.initialHolderAddress,
      `${name}.initialHolderAddress`,
    ),
    initialSupply,
    name: nullableText(record.name, `${name}.name`, 100),
    symbol: nullableText(record.symbol, `${name}.symbol`, 10),
    decimals,
    tokenCodeHash,
    transactionHash: hash(record.transactionHash, `${name}.transactionHash`),
    eventSequence: integer(
      record.eventSequence,
      `${name}.eventSequence`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    blockHeight: decimal(record.blockHeight, `${name}.blockHeight`),
    indexedAt: timestamp(record.indexedAt, `${name}.indexedAt`),
  };
}

function validateStatus(
  value: unknown,
  config: RegistryConfig,
): RegistryStatus {
  const record = object(value, "registry status");
  const networkId = network(record.networkId, "networkId");
  const factoryAddress = address(record.factoryAddress, "factoryAddress");
  if (
    networkId !== config.networkIdHex ||
    factoryAddress !== toHex0x(config.factoryAddress)
  ) {
    throw new RegistryClientError(
      "Registry response has a different chain scope",
    );
  }
  const syncState = enumeration(record.syncState, SYNC_STATES, "syncState");
  const syncing = boolean(record.syncing, "syncing");
  if (syncing !== (syncState === "syncing" || syncState === "retrying")) {
    invalid("syncing");
  }
  return {
    networkId,
    factoryAddress,
    indexedThroughBlock: decimal(
      record.indexedThroughBlock,
      "indexedThroughBlock",
    ),
    tokenCount: integer(
      record.tokenCount,
      "tokenCount",
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

function validateQuery(query: RegistryTokenQuery): void {
  enumeration(query.sort, SORTS, "sort");
  integer(query.limit, "limit", 1, 100);
  integer(query.offset, "offset", 0, 10_000);
  if (query.creator !== undefined) address(query.creator, "creator");
  if (query.asOfBlock !== undefined) decimal(query.asOfBlock, "asOfBlock");
  if (
    query.q !== undefined &&
    new TextEncoder().encode(query.q.trim()).byteLength > 100
  ) {
    invalid("q");
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(name);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown, name: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) invalid(name);
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(name);
  return value;
}

function network(value: unknown, name: string): string {
  if (typeof value !== "string" || !NETWORK_ID.test(value)) invalid(name);
  return value;
}

function decimal(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_DECIMAL_DIGITS ||
    !DECIMAL.test(value)
  ) {
    invalid(name);
  }
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

function nullableInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : integer(value, name, minimum, maximum);
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
  ) {
    invalid(name);
  }
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
    ? left.localeCompare(right)
    : left.length - right.length;
}
