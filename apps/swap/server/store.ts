import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  REGISTRY_SORTS,
  type CommitPageOptions,
  type PoolQuery,
  type PoolQueryResult,
  type RegistryPool,
  type RegistryScan,
  type RegistryScope,
  type RegistryStatus,
  type RegistrySyncState,
} from "./domain.ts";
import {
  canonicalAddress,
  canonicalDecimal,
  canonicalHash,
  canonicalNetworkId,
  compareDecimal,
  escapeLike,
  normalizedSearch,
  ValidationError,
} from "./validation.ts";

const SCHEMA_VERSION = 1;
const MAX_CURSOR_CHARACTERS = 4_096;
const MAX_ERROR_BYTES = 500;
const MAX_PAIR_COUNT = 0xffff_ffffn;
const ZERO_ADDRESS = `0x${"0".repeat(64)}`;
const STATE_KEYS = new Set([
  "indexed_through_block",
  "history_limited",
  "sync_state",
  "last_successful_sync_at",
  "last_error",
  "scan_anchor_block",
  "scan_target_block",
  "scan_next_cursor",
  "retention_baseline_pending",
]);

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
    super("Conflicting immutable pool creation evidence");
    this.name = "ImmutableRegistryConflictError";
  }
}

export class PairCountIntegrityError extends RegistryStoreError {
  constructor() {
    super("Pool pair counts are not contiguous");
    this.name = "PairCountIntegrityError";
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
      this.#validateStorage();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  healthCheck(): boolean {
    try {
      const scopeCount = integerColumn(
        this.#database
          .prepare("SELECT count(*) AS count FROM registry_scope")
          .get(),
        "count",
      );
      const stateCount = integerColumn(
        this.#database
          .prepare(
            "SELECT count(*) AS count FROM registry_state WHERE key IN ('indexed_through_block', 'history_limited', 'sync_state')",
          )
          .get(),
        "count",
      );
      integerColumn(
        this.#database.prepare("SELECT count(*) AS count FROM pools").get(),
        "count",
      );
      integerColumn(
        this.#database
          .prepare("SELECT count(*) AS count FROM pair_count_baselines")
          .get(),
        "count",
      );
      return scopeCount === 1 && stateCount === 3;
    } catch {
      return false;
    }
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
    pools: readonly RegistryPool[],
    nextCursor: string | null,
    options: CommitPageOptions = {},
  ): void {
    if (nextCursor !== null) validateCursor(nextCursor);

    this.#transaction(() => {
      const scan = this.getScan();
      if (scan === null) {
        throw new RegistryStoreError("No registry scan is in progress");
      }
      if (options.retentionGap === true && scan.nextCursor !== null) {
        throw new PairCountIntegrityError();
      }
      if (options.retentionGap === true) {
        this.#setState("history_limited", "true");
        this.#setState("retention_baseline_pending", "true");
      }

      for (const value of pools) {
        const pool = normalizePool(value, this.#scope);
        if (
          compareDecimal(pool.createdBlock, scan.anchorBlock) < 0 ||
          compareDecimal(pool.createdBlock, scan.targetBlock) > 0
        ) {
          throw new ValidationError(
            "pool creation block is outside the active scan",
          );
        }
        const baselinePending =
          this.#state("retention_baseline_pending") === "true";
        this.#insertPool(pool, baselinePending);
        if (baselinePending) {
          this.#deleteState("retention_baseline_pending");
        }
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
      .prepare("SELECT count(*) AS count FROM pools")
      .get();
    const syncState = this.#state("sync_state") ?? "idle";
    if (!isSyncState(syncState)) {
      throw new RegistryStoreError("Registry sync state is invalid");
    }
    return {
      ...this.#scope,
      indexedThroughBlock: this.#state("indexed_through_block") ?? "0",
      poolCount: integerColumn(count, "count"),
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
        if (
          update.historyLimited === false &&
          this.#state("history_limited") === "true"
        ) {
          throw new ValidationError("historyLimited cannot be cleared");
        }
        this.#setState("history_limited", String(update.historyLimited));
      }
      if (update.syncState !== undefined) {
        if (!isSyncState(update.syncState)) {
          throw new ValidationError("syncState is invalid");
        }
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
        this.#setOptionalState(
          "last_error",
          update.lastError === null
            ? null
            : truncateUtf8(update.lastError, MAX_ERROR_BYTES),
        );
      }
    });
  }

  queryPools(query: PoolQuery): PoolQueryResult {
    validatePoolQuery(query);
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

    const conditions = [decimalLessThanOrEqualSql("created_block")];
    const parameters: SQLInputValue[] = [asOfBlock, asOfBlock, asOfBlock];
    if (query.token !== undefined) {
      const token = canonicalAddress(query.token, "token");
      conditions.push("(token0_address = ? OR token1_address = ?)");
      parameters.push(token, token);
    }
    const search = query.q?.normalize("NFKC").trim();
    if (search !== undefined && search !== "") {
      const pattern = `%${escapeLike(normalizedSearch(search))}%`;
      conditions.push(
        "(token0_address LIKE ? ESCAPE '\\' OR token1_address LIKE ? ESCAPE '\\' OR liquidity_token_address LIKE ? ESCAPE '\\' OR handler_address LIKE ? ESCAPE '\\' OR driver_address LIKE ? ESCAPE '\\')",
      );
      parameters.push(pattern, pattern, pattern, pattern, pattern);
    }
    const where = conditions.join(" AND ");
    const count = integerColumn(
      this.#database
        .prepare(`SELECT count(*) AS count FROM pools WHERE ${where}`)
        .get(...parameters),
      "count",
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM pools WHERE ${where} ORDER BY ${sortSql(query.sort)} LIMIT ? OFFSET ?`,
      )
      .all(...parameters, query.limit, query.offset);
    return {
      ...this.#scope,
      pools: rows.map(rowToPool),
      total: count,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + rows.length < count,
      asOfBlock,
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
    const version = integerColumn(
      this.#database.prepare("PRAGMA user_version").get(),
      "user_version",
    );
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
          factory_address TEXT NOT NULL
        );
        CREATE TABLE pair_count_baselines (
          pair_count TEXT PRIMARY KEY
        );
        CREATE TABLE pools (
          network_id TEXT NOT NULL,
          factory_address TEXT NOT NULL,
          token0_address TEXT NOT NULL,
          token1_address TEXT NOT NULL,
          liquidity_token_address TEXT NOT NULL,
          handler_address TEXT NOT NULL,
          driver_address TEXT NOT NULL,
          pair_count TEXT NOT NULL,
          transaction_hash TEXT NOT NULL,
          event_sequence TEXT NOT NULL,
          created_block TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (token0_address, token1_address),
          UNIQUE (transaction_hash, event_sequence),
          UNIQUE (handler_address),
          UNIQUE (liquidity_token_address),
          UNIQUE (driver_address),
          UNIQUE (pair_count)
        );
        CREATE INDEX pools_created ON pools(length(created_block), created_block);
        CREATE INDEX pools_token1 ON pools(token1_address, token0_address);
        PRAGMA user_version=1;
      `);
      this.#setState("indexed_through_block", "0");
      this.#setState("history_limited", "false");
      this.#setState("sync_state", "idle");
      this.#database
        .prepare(
          "INSERT INTO registry_scope(singleton, network_id, factory_address) VALUES (1, ?, ?)",
        )
        .run(this.#scope.networkId, this.#scope.factoryAddress);
    });
  }

  #bindScope(): void {
    const rows = this.#database
      .prepare("SELECT network_id, factory_address FROM registry_scope")
      .all();
    if (rows.length === 0) {
      throw new RegistryStoreError("Registry database scope is missing");
    }
    if (rows.length !== 1) {
      throw new RegistryStoreError("Registry database scope is malformed");
    }

    let networkId: string;
    let factoryAddress: string;
    try {
      const row = rows[0];
      networkId = stringColumn(row, "network_id");
      factoryAddress = stringColumn(row, "factory_address");
      if (
        canonicalNetworkId(networkId, "network ID") !== networkId ||
        canonicalAddress(factoryAddress, "factory address") !== factoryAddress
      ) {
        throw new Error("Noncanonical scope");
      }
    } catch {
      throw new RegistryStoreError("Registry database scope is malformed");
    }
    if (
      networkId !== this.#scope.networkId ||
      factoryAddress !== this.#scope.factoryAddress
    ) {
      throw new RegistryScopeMismatchError();
    }
  }

  #validateStorage(): void {
    try {
      this.#validateStateRows();
      const indexedThroughBlock = requiredCanonicalDecimal(
        this.#state("indexed_through_block"),
        "indexed through block",
      );
      const historyLimited = this.#state("history_limited");
      if (historyLimited !== "true" && historyLimited !== "false") {
        throw new ValidationError("history limited state is invalid");
      }
      const syncState = this.#state("sync_state");
      if (syncState === null || !isSyncState(syncState)) {
        throw new ValidationError("sync state is invalid");
      }

      const lastSuccessfulSyncAt = this.#state("last_successful_sync_at");
      if (
        lastSuccessfulSyncAt !== null &&
        !isIsoTimestamp(lastSuccessfulSyncAt)
      ) {
        throw new ValidationError("last successful sync time is invalid");
      }
      const lastError = this.#state("last_error");
      if (
        lastError !== null &&
        Buffer.byteLength(lastError) > MAX_ERROR_BYTES
      ) {
        throw new ValidationError("last error is too large");
      }

      const anchorBlock = this.#state("scan_anchor_block");
      const targetBlock = this.#state("scan_target_block");
      const nextCursor = this.#state("scan_next_cursor");
      if ((anchorBlock === null) !== (targetBlock === null)) {
        throw new ValidationError("scan state is incomplete");
      }
      if (anchorBlock === null) {
        if (nextCursor !== null) {
          throw new ValidationError("scan cursor has no active scan");
        }
      } else {
        const anchor = requiredCanonicalDecimal(
          anchorBlock,
          "scan anchor block",
        );
        const target = requiredCanonicalDecimal(
          targetBlock,
          "scan target block",
        );
        if (
          anchor !== (BigInt(indexedThroughBlock) + 1n).toString() ||
          compareDecimal(anchor, target) > 0
        ) {
          throw new ValidationError("scan bounds are invalid");
        }
        if (nextCursor !== null) validateCursor(nextCursor);
      }

      const pendingBaseline = this.#state("retention_baseline_pending");
      if (pendingBaseline !== null && pendingBaseline !== "true") {
        throw new ValidationError("retention baseline state is invalid");
      }
      if (pendingBaseline !== null && historyLimited !== "true") {
        throw new ValidationError("retention state requires limited history");
      }

      const baselines = new Set<string>();
      for (const row of this.#database
        .prepare("SELECT pair_count FROM pair_count_baselines")
        .all()) {
        const value = stringColumn(row, "pair_count");
        if (validatePairCount(value) !== value || baselines.has(value)) {
          throw new ValidationError("pair count baselines are invalid");
        }
        baselines.add(value);
      }
      if (baselines.size > 0 && historyLimited !== "true") {
        throw new ValidationError("retention state requires limited history");
      }

      const rows = this.#database
        .prepare(
          "SELECT * FROM pools ORDER BY length(pair_count) ASC, pair_count ASC",
        )
        .all();
      this.#validatePoolRows(
        rows,
        indexedThroughBlock,
        anchorBlock,
        targetBlock,
        baselines,
      );
    } catch (error) {
      if (error instanceof RegistryStoreError) throw error;
      throw new RegistryStoreError("Registry database storage is invalid");
    }
  }

  #validateStateRows(): void {
    const rows = this.#database
      .prepare("SELECT key, value FROM registry_state")
      .all();
    const keys = new Set<string>();
    for (const row of rows) {
      const key = stringColumn(row, "key");
      stringColumn(row, "value");
      if (!STATE_KEYS.has(key) || keys.has(key)) {
        throw new ValidationError("registry state keys are invalid");
      }
      keys.add(key);
    }
    for (const required of [
      "indexed_through_block",
      "history_limited",
      "sync_state",
    ]) {
      if (!keys.has(required)) {
        throw new ValidationError(
          `required registry state ${required} is missing`,
        );
      }
    }
  }

  #validatePoolRows(
    rows: object[],
    indexedThroughBlock: string,
    anchorBlock: string | null,
    targetBlock: string | null,
    baselines: Set<string>,
  ): void {
    const pairs = new Set<string>();
    const events = new Set<string>();
    const handlers = new Set<string>();
    const liquidityTokens = new Set<string>();
    const drivers = new Set<string>();
    let previousPairCount: string | null = null;
    const usedBaselines = new Set<string>();

    for (const row of rows) {
      const stored = rowToPool(row);
      const pool = normalizePool(stored, this.#scope);
      if (!sameStoredPool(pool, stored)) {
        throw new ValidationError("pool evidence is not canonical");
      }
      const maximumBlock = targetBlock ?? indexedThroughBlock;
      if (compareDecimal(pool.createdBlock, maximumBlock) > 0) {
        throw new ValidationError("pool creation block exceeds registry state");
      }
      if (
        anchorBlock !== null &&
        compareDecimal(pool.createdBlock, indexedThroughBlock) > 0 &&
        compareDecimal(pool.createdBlock, anchorBlock) < 0
      ) {
        throw new ValidationError("pool creation block is outside scan state");
      }

      requireUnique(pairs, `${pool.token0Address}:${pool.token1Address}`);
      requireUnique(events, `${pool.transactionHash}:${pool.eventSequence}`);
      requireUnique(handlers, pool.handlerAddress);
      requireUnique(liquidityTokens, pool.liquidityTokenAddress);
      requireUnique(drivers, pool.driverAddress);

      if (previousPairCount === null) {
        if (pool.pairCount !== "1" && !baselines.has(pool.pairCount)) {
          throw new PairCountIntegrityError();
        }
        if (pool.pairCount !== "1") usedBaselines.add(pool.pairCount);
      } else {
        const expected = (BigInt(previousPairCount) + 1n).toString();
        if (pool.pairCount !== expected) {
          if (!baselines.has(pool.pairCount)) {
            throw new PairCountIntegrityError();
          }
          usedBaselines.add(pool.pairCount);
        }
      }
      previousPairCount = pool.pairCount;
    }
    if (usedBaselines.size !== baselines.size) {
      throw new PairCountIntegrityError();
    }
  }

  #insertPool(pool: RegistryPool, retainedBaselineAllowed: boolean): void {
    const candidates = this.#database
      .prepare(
        `SELECT * FROM pools WHERE
          (token0_address = ? AND token1_address = ?) OR
          (transaction_hash = ? AND event_sequence = ?) OR
          handler_address = ? OR liquidity_token_address = ? OR
          driver_address = ? OR pair_count = ?`,
      )
      .all(
        pool.token0Address,
        pool.token1Address,
        pool.transactionHash,
        pool.eventSequence,
        pool.handlerAddress,
        pool.liquidityTokenAddress,
        pool.driverAddress,
        pool.pairCount,
      );
    if (candidates.length > 0) {
      if (candidates.every((row) => sameEvidence(rowToPool(row), pool))) {
        return;
      }
      throw new ImmutableRegistryConflictError();
    }

    const maximumPairCount = this.#maximumPairCount();
    if (retainedBaselineAllowed) {
      if (
        maximumPairCount !== null &&
        compareDecimal(pool.pairCount, maximumPairCount) <= 0
      ) {
        throw new PairCountIntegrityError();
      }
      if (
        pool.pairCount !==
        (maximumPairCount === null
          ? "1"
          : (BigInt(maximumPairCount) + 1n).toString())
      ) {
        this.#database
          .prepare(
            "INSERT INTO pair_count_baselines(pair_count) VALUES (?) ON CONFLICT(pair_count) DO NOTHING",
          )
          .run(pool.pairCount);
      }
    } else if (
      pool.pairCount !==
      (maximumPairCount === null
        ? "1"
        : (BigInt(maximumPairCount) + 1n).toString())
    ) {
      throw new PairCountIntegrityError();
    }

    try {
      this.#database
        .prepare(
          `INSERT INTO pools (
            network_id, factory_address, token0_address, token1_address,
            liquidity_token_address, handler_address, driver_address,
            pair_count, transaction_hash, event_sequence, created_block,
            indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pool.networkId,
          pool.factoryAddress,
          pool.token0Address,
          pool.token1Address,
          pool.liquidityTokenAddress,
          pool.handlerAddress,
          pool.driverAddress,
          pool.pairCount,
          pool.transactionHash,
          pool.eventSequence,
          pool.createdBlock,
          pool.indexedAt,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new ImmutableRegistryConflictError();
      throw error;
    }
  }

  #maximumPairCount(): string | null {
    const row = this.#database
      .prepare(
        "SELECT pair_count FROM pools ORDER BY length(pair_count) DESC, pair_count DESC LIMIT 1",
      )
      .get();
    return row === undefined ? null : stringColumn(row, "pair_count");
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
  };
}

function normalizePool(
  value: RegistryPool,
  scope: RegistryScope,
): RegistryPool {
  const pool: RegistryPool = {
    networkId: canonicalNetworkId(value.networkId, "network ID"),
    factoryAddress: canonicalAddress(value.factoryAddress, "factory address"),
    token0Address: canonicalAddress(value.token0Address, "token0 address"),
    token1Address: canonicalAddress(value.token1Address, "token1 address"),
    liquidityTokenAddress: canonicalAddress(
      value.liquidityTokenAddress,
      "liquidity token address",
    ),
    handlerAddress: canonicalAddress(value.handlerAddress, "handler address"),
    driverAddress: canonicalAddress(value.driverAddress, "driver address"),
    pairCount: canonicalDecimal(value.pairCount, "pair count"),
    transactionHash: canonicalHash(value.transactionHash, "transaction hash"),
    eventSequence: canonicalDecimal(value.eventSequence, "event sequence"),
    createdBlock: canonicalDecimal(value.createdBlock, "created block"),
    indexedAt: value.indexedAt,
  };
  if (
    pool.networkId !== scope.networkId ||
    pool.factoryAddress !== scope.factoryAddress
  ) {
    throw new RegistryScopeMismatchError();
  }
  if (
    pool.token0Address === ZERO_ADDRESS ||
    pool.token1Address === ZERO_ADDRESS ||
    pool.liquidityTokenAddress === ZERO_ADDRESS ||
    pool.handlerAddress === ZERO_ADDRESS ||
    pool.driverAddress === ZERO_ADDRESS
  ) {
    throw new ValidationError("pool addresses must be nonzero");
  }
  if (pool.token0Address >= pool.token1Address) {
    throw new ValidationError(
      "pool token addresses must be canonically ordered",
    );
  }
  validatePairCount(pool.pairCount);
  if (!isIsoTimestamp(pool.indexedAt)) {
    throw new ValidationError("indexedAt must be an ISO timestamp");
  }
  return pool;
}

function validatePoolQuery(query: PoolQuery): void {
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
  if (query.q !== undefined) {
    const search = query.q.normalize("NFKC").trim();
    if (Buffer.byteLength(search) > 100) {
      throw new ValidationError("q must contain at most 100 UTF-8 bytes");
    }
  }
}

function rowToPool(row: object): RegistryPool {
  return {
    networkId: stringColumn(row, "network_id"),
    factoryAddress: stringColumn(row, "factory_address"),
    token0Address: stringColumn(row, "token0_address"),
    token1Address: stringColumn(row, "token1_address"),
    liquidityTokenAddress: stringColumn(row, "liquidity_token_address"),
    handlerAddress: stringColumn(row, "handler_address"),
    driverAddress: stringColumn(row, "driver_address"),
    pairCount: stringColumn(row, "pair_count"),
    transactionHash: stringColumn(row, "transaction_hash"),
    eventSequence: stringColumn(row, "event_sequence"),
    createdBlock: stringColumn(row, "created_block"),
    indexedAt: stringColumn(row, "indexed_at"),
  };
}

function sameEvidence(left: RegistryPool, right: RegistryPool): boolean {
  return (
    left.networkId === right.networkId &&
    left.factoryAddress === right.factoryAddress &&
    left.token0Address === right.token0Address &&
    left.token1Address === right.token1Address &&
    left.liquidityTokenAddress === right.liquidityTokenAddress &&
    left.handlerAddress === right.handlerAddress &&
    left.driverAddress === right.driverAddress &&
    left.pairCount === right.pairCount &&
    left.transactionHash === right.transactionHash &&
    left.eventSequence === right.eventSequence &&
    left.createdBlock === right.createdBlock
  );
}

function sameStoredPool(left: RegistryPool, right: RegistryPool): boolean {
  return sameEvidence(left, right) && left.indexedAt === right.indexedAt;
}

function sortSql(sort: PoolQuery["sort"]): string {
  const creationAscending =
    "length(created_block) ASC, created_block ASC, length(event_sequence) ASC, event_sequence ASC, token0_address ASC, token1_address ASC";
  switch (sort) {
    case "newest":
      return "length(created_block) DESC, created_block DESC, length(event_sequence) DESC, event_sequence DESC, token0_address ASC, token1_address ASC";
    case "oldest":
      return creationAscending;
    case "token0":
      return `token0_address ASC, token1_address ASC, ${creationAscending}`;
    case "token1":
      return `token1_address ASC, token0_address ASC, ${creationAscending}`;
  }
}

function decimalLessThanOrEqualSql(column: string): string {
  return `(length(${column}) < length(?) OR (length(${column}) = length(?) AND ${column} <= ?))`;
}

function stringColumn(row: object | undefined, key: string): string {
  const value = row === undefined ? undefined : Reflect.get(row, key);
  if (typeof value !== "string") {
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

function isSyncState(value: string): value is RegistrySyncState {
  return ["idle", "syncing", "retrying", "integrityFault"].includes(value);
}

function isIsoTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function requiredCanonicalDecimal(value: string | null, name: string): string {
  if (value === null) {
    throw new ValidationError(`${name} is missing`);
  }
  return canonicalDecimal(value, name);
}

function validatePairCount(value: string): string {
  const pairCount = canonicalDecimal(value, "pair count");
  if (pairCount === "0" || BigInt(pairCount) > MAX_PAIR_COUNT) {
    throw new ValidationError("pair count must be between 1 and 4294967295");
  }
  return pairCount;
}

function validateCursor(value: string): void {
  if (value.length === 0 || value.length > MAX_CURSOR_CHARACTERS) {
    throw new ValidationError(
      "next cursor must contain between 1 and 4096 characters",
    );
  }
}

function requireUnique(values: Set<string>, value: string): void {
  if (values.has(value)) throw new ImmutableRegistryConflictError();
  values.add(value);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_SQLITE_CONSTRAINT")
  );
}
