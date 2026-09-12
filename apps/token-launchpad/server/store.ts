import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  RegistryScan,
  RegistryScope,
  RegistryStatus,
  RegistrySyncState,
  RegistryToken,
  TokenQuery,
  TokenQueryResult,
} from "./domain.ts";
import { REGISTRY_SORTS } from "./domain.ts";
import { MAX_SIGNED_AMOUNT } from "../src/runtime.ts";
import {
  canonicalAddress,
  canonicalDecimal,
  canonicalHash,
  canonicalNetworkId,
  escapeLike,
  normalizedSearch,
  ValidationError,
} from "./validation.ts";

const SCHEMA_VERSION = 1;
const MAX_ERROR_BYTES = 500;

export class RegistryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryStoreError";
  }
}

export class RegistryScopeMismatchError extends RegistryStoreError {
  constructor() {
    super("The registry database belongs to a different chain scope");
    this.name = "RegistryScopeMismatchError";
  }
}

export class ImmutableRegistryConflictError extends RegistryStoreError {
  constructor() {
    super("Conflicting immutable token creation evidence");
    this.name = "ImmutableRegistryConflictError";
  }
}

export class RegistryStore {
  readonly #database: DatabaseSync;
  readonly #scope: RegistryScope;

  constructor(databasePath: string, scope: RegistryScope) {
    this.#scope = normalizeScope(scope);
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#configure();
      this.#migrate();
      this.#bindScope();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  healthCheck(): boolean {
    const row = this.#database.prepare("SELECT 1 AS ready").get();
    return integerColumn(row, "ready") === 1;
  }

  getScan(): RegistryScan | null {
    const anchorBlock = this.#state("scan_anchor_block");
    const targetBlock = this.#state("scan_target_block");
    if (anchorBlock === null && targetBlock === null) return null;
    if (anchorBlock === null || targetBlock === null) {
      throw new RegistryStoreError("Registry scan state is incomplete");
    }
    return {
      anchorBlock,
      targetBlock,
      nextCursor: this.#state("scan_next_cursor"),
    };
  }

  beginScan(anchorBlock: string, targetBlock: string): void {
    const anchor = canonicalDecimal(anchorBlock, "scan anchor block");
    const target = canonicalDecimal(targetBlock, "scan target block");
    if (compareDecimal(anchor, target) > 0) {
      throw new ValidationError("scan anchor block must not exceed its target");
    }
    this.#transaction(() => {
      const current = this.getScan();
      if (current !== null) {
        if (current.anchorBlock !== anchor || current.targetBlock !== target) {
          throw new RegistryStoreError(
            "A different registry scan is already in progress",
          );
        }
        return;
      }
      const indexedThroughBlock = this.#state("indexed_through_block") ?? "0";
      if (anchor !== (BigInt(indexedThroughBlock) + 1n).toString()) {
        throw new ValidationError(
          "scan anchor block must follow the indexed registry height",
        );
      }
      this.#setState("scan_anchor_block", anchor);
      this.#setState("scan_target_block", target);
      this.#deleteState("scan_next_cursor");
    });
  }

  resetScanCursor(): void {
    if (this.getScan() === null) {
      throw new RegistryStoreError("No registry scan is in progress");
    }
    this.#deleteState("scan_next_cursor");
  }

  commitPage(
    tokens: readonly RegistryToken[],
    nextCursor: string | null,
  ): void {
    if (
      nextCursor !== null &&
      (nextCursor === "" || Buffer.byteLength(nextCursor) > 2_048)
    ) {
      throw new ValidationError("next cursor must contain at most 2048 bytes");
    }
    this.#transaction(() => {
      const scan = this.getScan();
      if (scan === null)
        throw new RegistryStoreError("No registry scan is in progress");
      for (const token of tokens) {
        const normalized = normalizeToken(token, this.#scope);
        if (
          compareDecimal(normalized.blockHeight, scan.anchorBlock) < 0 ||
          compareDecimal(normalized.blockHeight, scan.targetBlock) > 0
        ) {
          throw new ValidationError(
            "token block height is outside the active scan",
          );
        }
        this.#insertToken(normalized);
      }
      if (nextCursor === null) {
        this.#setState("indexed_through_block", scan.targetBlock);
        this.#deleteState("scan_anchor_block");
        this.#deleteState("scan_target_block");
        this.#deleteState("scan_next_cursor");
      } else {
        this.#setState("scan_next_cursor", nextCursor);
      }
    });
  }

  getStatus(): RegistryStatus {
    const count = this.#database
      .prepare(
        "SELECT count(*) AS count FROM tokens WHERE network_id = ? AND factory_address = ?",
      )
      .get(this.#scope.networkId, this.#scope.factoryAddress);
    const syncState = this.#state("sync_state") ?? "idle";
    if (!isSyncState(syncState)) {
      throw new RegistryStoreError("Registry sync state is invalid");
    }
    return {
      networkId: this.#scope.networkId,
      factoryAddress: this.#scope.factoryAddress,
      indexedThroughBlock: this.#state("indexed_through_block") ?? "0",
      tokenCount: integerColumn(count, "count"),
      historyLimited: this.#state("history_limited") === "true",
      syncState,
      syncing: syncState === "syncing" || syncState === "retrying",
      lastSuccessfulSyncAt: this.#state("last_successful_sync_at"),
      lastError: this.#state("last_error"),
    };
  }

  updateStatus(update: {
    historyLimited?: boolean;
    syncState?: RegistrySyncState;
    lastSuccessfulSyncAt?: string | null;
    lastError?: string | null;
  }): void {
    this.#transaction(() => {
      if (update.historyLimited !== undefined) {
        this.#setState("history_limited", String(update.historyLimited));
      }
      if (update.syncState !== undefined) {
        this.#setState("sync_state", update.syncState);
      }
      if (update.lastSuccessfulSyncAt !== undefined) {
        if (
          update.lastSuccessfulSyncAt !== null &&
          !isIsoTimestamp(update.lastSuccessfulSyncAt)
        ) {
          throw new ValidationError(
            "lastSuccessfulSyncAt must be an ISO timestamp",
          );
        }
        this.#setOptionalState(
          "last_successful_sync_at",
          update.lastSuccessfulSyncAt,
        );
      }
      if (update.lastError !== undefined) {
        const error = update.lastError;
        this.#setOptionalState(
          "last_error",
          error === null ? null : truncateUtf8(error, MAX_ERROR_BYTES),
        );
      }
    });
  }

  queryTokens(query: TokenQuery): TokenQueryResult {
    validateTokenQuery(query);
    const indexedThroughBlock = this.#state("indexed_through_block") ?? "0";
    const asOfBlock = canonicalDecimal(
      query.asOfBlock ?? indexedThroughBlock,
      "asOfBlock",
    );
    if (compareDecimal(asOfBlock, indexedThroughBlock) > 0) {
      throw new ValidationError(
        "asOfBlock exceeds the indexed registry height",
      );
    }
    const conditions = [
      "network_id = ?",
      "factory_address = ?",
      "(length(block_height) < length(?) OR (length(block_height) = length(?) AND block_height <= ?))",
    ];
    const parameters: SQLInputValue[] = [
      this.#scope.networkId,
      this.#scope.factoryAddress,
      asOfBlock,
      asOfBlock,
      asOfBlock,
    ];
    if (query.creator !== undefined) {
      conditions.push("creator_address = ?");
      parameters.push(canonicalAddress(query.creator, "creator"));
    }
    if (query.tokenAddress !== undefined) {
      conditions.push("token_address = ?");
      parameters.push(canonicalAddress(query.tokenAddress, "tokenAddress"));
    }
    const search = query.q?.trim();
    if (search !== undefined && search !== "") {
      const pattern = `%${escapeLike(normalizedSearch(search))}%`;
      conditions.push(
        "(search_name LIKE ? ESCAPE '\\' OR search_symbol LIKE ? ESCAPE '\\' OR token_address LIKE ? ESCAPE '\\' OR creator_address LIKE ? ESCAPE '\\')",
      );
      parameters.push(pattern, pattern, pattern, pattern);
    }
    const where = conditions.join(" AND ");
    const countRow = this.#database
      .prepare(`SELECT count(*) AS count FROM tokens WHERE ${where}`)
      .get(...parameters);
    const total = integerColumn(countRow, "count");
    const rows = this.#database
      .prepare(
        `SELECT * FROM tokens WHERE ${where} ORDER BY ${sortSql(query.sort)} LIMIT ? OFFSET ?`,
      )
      .all(...parameters, query.limit, query.offset);
    return {
      tokens: rows.map(rowToToken),
      total,
      limit: query.limit,
      offset: query.offset,
      asOfBlock,
      hasMore: query.offset + rows.length < total,
      historyLimited: this.#state("history_limited") === "true",
    };
  }

  #configure(): void {
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.#database.exec("PRAGMA busy_timeout=5000");
  }

  #migrate(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get();
    const version = integerColumn(versionRow, "user_version");
    if (version > SCHEMA_VERSION) {
      throw new RegistryStoreError(
        `Unsupported registry schema version ${version}`,
      );
    }
    if (version === SCHEMA_VERSION) return;
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE registry_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE registry_scope (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          network_id TEXT NOT NULL,
          factory_address TEXT NOT NULL,
          token_code_hash TEXT NOT NULL
        );
        CREATE TABLE tokens (
          network_id TEXT NOT NULL,
          factory_address TEXT NOT NULL,
          token_address TEXT NOT NULL,
          creator_address TEXT NOT NULL,
          administrator_address TEXT NOT NULL,
          initial_holder_address TEXT NOT NULL,
          initial_supply TEXT NOT NULL,
          name TEXT,
          symbol TEXT,
          search_name TEXT,
          search_symbol TEXT,
          decimals INTEGER,
          token_code_hash TEXT NOT NULL,
          transaction_hash TEXT NOT NULL,
          event_sequence INTEGER NOT NULL,
          block_height TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (network_id, factory_address, token_address),
          UNIQUE (network_id, transaction_hash, event_sequence)
        );
        CREATE INDEX tokens_creator ON tokens(network_id, factory_address, creator_address);
        CREATE INDEX tokens_block ON tokens(network_id, factory_address, length(block_height), block_height);
        CREATE INDEX tokens_name ON tokens(network_id, factory_address, search_name, token_address);
        CREATE INDEX tokens_symbol ON tokens(network_id, factory_address, search_symbol, token_address);
        PRAGMA user_version=1;
      `);
      this.#setState("indexed_through_block", "0");
      this.#setState("history_limited", "false");
      this.#setState("sync_state", "idle");
      this.#database
        .prepare(
          "INSERT INTO registry_scope(singleton, network_id, factory_address, token_code_hash) VALUES (1, ?, ?, ?)",
        )
        .run(
          this.#scope.networkId,
          this.#scope.factoryAddress,
          this.#scope.tokenCodeHash,
        );
    });
  }

  #bindScope(): void {
    const row = this.#database
      .prepare(
        "SELECT network_id, factory_address, token_code_hash FROM registry_scope WHERE singleton = 1",
      )
      .get();
    if (row === undefined) {
      throw new RegistryStoreError("Registry database scope is missing");
    }
    if (
      stringColumn(row, "network_id") !== this.#scope.networkId ||
      stringColumn(row, "factory_address") !== this.#scope.factoryAddress ||
      stringColumn(row, "token_code_hash") !== this.#scope.tokenCodeHash
    ) {
      throw new RegistryScopeMismatchError();
    }
  }

  #insertToken(token: RegistryToken): void {
    const existingByToken = this.#database
      .prepare(
        "SELECT * FROM tokens WHERE network_id = ? AND factory_address = ? AND token_address = ?",
      )
      .get(token.networkId, token.factoryAddress, token.tokenAddress);
    const existingByEvent = this.#database
      .prepare(
        "SELECT * FROM tokens WHERE network_id = ? AND transaction_hash = ? AND event_sequence = ?",
      )
      .get(token.networkId, token.transactionHash, token.eventSequence);
    if (existingByToken !== undefined || existingByEvent !== undefined) {
      if (
        (existingByToken === undefined ||
          sameEvidence(rowToToken(existingByToken), token)) &&
        (existingByEvent === undefined ||
          sameEvidence(rowToToken(existingByEvent), token))
      ) {
        return;
      }
      throw new ImmutableRegistryConflictError();
    }
    this.#database
      .prepare(
        `
        INSERT INTO tokens (
          network_id, factory_address, token_address, creator_address,
          administrator_address, initial_holder_address, initial_supply,
          name, symbol, search_name, search_symbol, decimals, token_code_hash,
          transaction_hash, event_sequence, block_height, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        token.networkId,
        token.factoryAddress,
        token.tokenAddress,
        token.creatorAddress,
        token.administratorAddress,
        token.initialHolderAddress,
        token.initialSupply,
        token.name,
        token.symbol,
        token.name === null ? null : normalizedSearch(token.name),
        token.symbol === null ? null : normalizedSearch(token.symbol),
        token.decimals,
        token.tokenCodeHash,
        token.transactionHash,
        token.eventSequence,
        token.blockHeight,
        token.indexedAt,
      );
  }

  #state(key: string): string | null {
    const row = this.#database
      .prepare("SELECT value FROM registry_state WHERE key = ?")
      .get(key);
    return row === undefined ? null : stringColumn(row, "value");
  }

  #setState(key: string, value: string): void {
    this.#database
      .prepare(
        "INSERT INTO registry_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  #setOptionalState(key: string, value: string | null): void {
    if (value === null) this.#deleteState(key);
    else this.#setState(key, value);
  }

  #deleteState(key: string): void {
    this.#database.prepare("DELETE FROM registry_state WHERE key = ?").run(key);
  }

  #transaction(action: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function normalizeScope(scope: RegistryScope): RegistryScope {
  return {
    networkId: canonicalNetworkId(scope.networkId, "network ID"),
    factoryAddress: canonicalAddress(scope.factoryAddress, "factory address"),
    tokenCodeHash: canonicalHash(scope.tokenCodeHash, "token code hash"),
  };
}

function validateTokenQuery(query: TokenQuery): void {
  if (!REGISTRY_SORTS.some((sort) => sort === query.sort)) {
    throw new ValidationError("sort is invalid");
  }
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
    throw new ValidationError("limit must be between 1 and 100");
  }
  if (
    !Number.isInteger(query.offset) ||
    query.offset < 0 ||
    query.offset > 10_000
  ) {
    throw new ValidationError("offset must be between 0 and 10000");
  }
  if (query.q !== undefined && Buffer.byteLength(query.q.trim()) > 100) {
    throw new ValidationError("q must contain at most 100 UTF-8 bytes");
  }
}

function normalizeToken(
  token: RegistryToken,
  scope: RegistryScope,
): RegistryToken {
  const normalized: RegistryToken = {
    ...token,
    networkId: canonicalNetworkId(token.networkId, "network ID"),
    factoryAddress: canonicalAddress(token.factoryAddress, "factory address"),
    tokenAddress: canonicalAddress(token.tokenAddress, "token address"),
    creatorAddress: canonicalAddress(token.creatorAddress, "creator address"),
    administratorAddress: canonicalAddress(
      token.administratorAddress,
      "administrator address",
    ),
    initialHolderAddress: canonicalAddress(
      token.initialHolderAddress,
      "initial holder address",
    ),
    initialSupply: canonicalDecimal(token.initialSupply, "initial supply"),
    tokenCodeHash: canonicalHash(token.tokenCodeHash, "token code hash"),
    transactionHash: canonicalHash(token.transactionHash, "transaction hash"),
    blockHeight: canonicalDecimal(token.blockHeight, "block height"),
  };
  if (
    normalized.networkId !== scope.networkId ||
    normalized.factoryAddress !== scope.factoryAddress ||
    normalized.tokenCodeHash !== scope.tokenCodeHash
  ) {
    throw new RegistryScopeMismatchError();
  }
  if (BigInt(normalized.initialSupply) > MAX_SIGNED_AMOUNT) {
    throw new ValidationError(
      "initial supply exceeds the signed 128-bit limit",
    );
  }
  if (!Number.isSafeInteger(token.eventSequence) || token.eventSequence < 0) {
    throw new ValidationError(
      "event sequence must be a non-negative safe integer",
    );
  }
  if (
    token.decimals !== null &&
    (!Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 0xffff_ffff)
  ) {
    throw new ValidationError("decimals must be between 0 and 4294967295");
  }
  if (!isIsoTimestamp(token.indexedAt)) {
    throw new ValidationError("indexedAt must be an ISO timestamp");
  }
  if (token.name !== null && Buffer.byteLength(token.name) > 100) {
    throw new ValidationError("name must contain at most 100 UTF-8 bytes");
  }
  if (token.symbol !== null && Buffer.byteLength(token.symbol) > 10) {
    throw new ValidationError("symbol must contain at most 10 UTF-8 bytes");
  }
  return normalized;
}

function rowToToken(row: object): RegistryToken {
  return {
    networkId: stringColumn(row, "network_id"),
    factoryAddress: stringColumn(row, "factory_address"),
    tokenAddress: stringColumn(row, "token_address"),
    creatorAddress: stringColumn(row, "creator_address"),
    administratorAddress: stringColumn(row, "administrator_address"),
    initialHolderAddress: stringColumn(row, "initial_holder_address"),
    initialSupply: stringColumn(row, "initial_supply"),
    name: nullableStringColumn(row, "name"),
    symbol: nullableStringColumn(row, "symbol"),
    decimals: nullableIntegerColumn(row, "decimals"),
    tokenCodeHash: stringColumn(row, "token_code_hash"),
    transactionHash: stringColumn(row, "transaction_hash"),
    eventSequence: integerColumn(row, "event_sequence"),
    blockHeight: stringColumn(row, "block_height"),
    indexedAt: stringColumn(row, "indexed_at"),
  };
}

function sameEvidence(left: RegistryToken, right: RegistryToken): boolean {
  return (
    left.networkId === right.networkId &&
    left.factoryAddress === right.factoryAddress &&
    left.tokenAddress === right.tokenAddress &&
    left.creatorAddress === right.creatorAddress &&
    left.administratorAddress === right.administratorAddress &&
    left.initialHolderAddress === right.initialHolderAddress &&
    left.initialSupply === right.initialSupply &&
    left.name === right.name &&
    left.symbol === right.symbol &&
    left.decimals === right.decimals &&
    left.tokenCodeHash === right.tokenCodeHash &&
    left.transactionHash === right.transactionHash &&
    left.eventSequence === right.eventSequence &&
    left.blockHeight === right.blockHeight
  );
}

function sortSql(sort: TokenQuery["sort"]): string {
  switch (sort) {
    case "newest":
      return "length(block_height) DESC, block_height DESC, token_address ASC";
    case "oldest":
      return "length(block_height) ASC, block_height ASC, token_address ASC";
    case "name":
      return "search_name IS NULL ASC, search_name ASC, token_address ASC";
    case "symbol":
      return "search_symbol IS NULL ASC, search_symbol ASC, token_address ASC";
  }
}

function stringColumn(row: object | undefined, key: string): string {
  const value = row === undefined ? undefined : Reflect.get(row, key);
  if (typeof value !== "string")
    throw new RegistryStoreError(`Invalid ${key} value`);
  return value;
}

function nullableStringColumn(row: object, key: string): string | null {
  const value = Reflect.get(row, key);
  if (value !== null && typeof value !== "string") {
    throw new RegistryStoreError(`Invalid ${key} value`);
  }
  return value;
}

function integerColumn(row: object | undefined, key: string): number {
  const value = row === undefined ? undefined : Reflect.get(row, key);
  if (typeof value === "bigint") {
    const converted = Number(value);
    if (Number.isSafeInteger(converted)) return converted;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RegistryStoreError(`Invalid ${key} value`);
  }
  return value;
}

function nullableIntegerColumn(row: object, key: string): number | null {
  const value = Reflect.get(row, key);
  return value === null ? null : integerColumn(row, key);
}

function compareDecimal(left: string, right: string): number {
  return left.length === right.length
    ? left.localeCompare(right)
    : left.length - right.length;
}

function isSyncState(value: string): value is RegistrySyncState {
  return ["idle", "syncing", "retrying", "integrityFault"].includes(value);
}

function isIsoTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}
