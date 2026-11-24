import { DatabaseSync } from "node:sqlite";

/** One created token, as the API returns it. */
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

/** The deployment a database indexes. */
export interface StoreScope {
  networkId: string;
  factoryAddress: string;
}

export interface TokenQuery {
  q?: string | undefined;
  creator?: string | undefined;
  limit: number;
  offset: number;
  /**
   * List only tokens created at or before this block. A visitor's first page
   * returns the indexer's checkpoint, and later pages send it back, so new
   * launches do not shift the pages they browse.
   */
  asOfBlock?: number | undefined;
}

/**
 * A small SQLite store for the indexer: one row per `TokenCreated` event, and
 * the block height the indexer has read through. A database belongs to one
 * network and factory.
 */
export class TokenStore {
  readonly #db: DatabaseSync;

  constructor(path: string, scope: StoreScope) {
    this.#db = new DatabaseSync(path);
    // The previous Launchpad kept a different schema in this file. Stop here
    // rather than fail on the first query.
    const previous = this.#db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registry_state'")
      .get();
    if (previous) {
      this.#db.close();
      throw new Error(
        `${path} was written by an earlier version of Launchpad. Set TOKEN_REGISTRY_DB_PATH to a new file; the indexer rebuilds the token list from the factory's events.`,
      );
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        transaction_hash TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        address TEXT NOT NULL,
        creator TEXT NOT NULL,
        name TEXT,
        symbol TEXT,
        decimals INTEGER,
        initial_supply TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        PRIMARY KEY (transaction_hash, sequence_number)
      );
      CREATE TABLE IF NOT EXISTS checkpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        block_height INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scope (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        network_id TEXT NOT NULL,
        factory_address TEXT NOT NULL
      );
    `);
    // A new file takes this scope. Another deployment's tokens and checkpoint
    // must not be served, or indexed from, for this one.
    this.#db
      .prepare("INSERT OR IGNORE INTO scope VALUES (1, ?, ?)")
      .run(scope.networkId, scope.factoryAddress);
    const saved = this.#db
      .prepare("SELECT network_id, factory_address FROM scope WHERE id = 1")
      .get() as { network_id: string; factory_address: string };
    if (
      saved.network_id !== scope.networkId ||
      saved.factory_address !== scope.factoryAddress
    ) {
      this.#db.close();
      throw new Error(
        `${path} indexes factory ${saved.factory_address} on network ${saved.network_id}, not this deployment. Set TOKEN_REGISTRY_DB_PATH to a new file.`,
      );
    }
  }

  /** Insert or replace by event identity, so replaying a block is safe. */
  saveToken(token: IndexedToken, sequenceNumber: number): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.transactionHash,
        sequenceNumber,
        token.address,
        token.creator,
        token.name,
        token.symbol,
        token.decimals,
        token.initialSupply,
        token.blockHeight,
      );
  }

  loadCheckpoint(): bigint | undefined {
    const row = this.#db
      .prepare("SELECT block_height FROM checkpoint WHERE id = 1")
      .get() as { block_height: number } | undefined;
    return row === undefined ? undefined : BigInt(row.block_height);
  }

  saveCheckpoint(blockHeight: bigint): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO checkpoint VALUES (1, ?)")
      .run(blockHeight);
  }

  /** Newest first. `q` matches the name, symbol, or address. */
  listTokens(query: TokenQuery): {
    tokens: IndexedToken[];
    hasMore: boolean;
    asOfBlock: string | null;
  } {
    // Stop at the checkpoint: every block up to it is fully indexed, while a
    // later block can still be gaining tokens from the next RPC page.
    const checkpoint = this.loadCheckpoint();
    const asOfBlock =
      query.asOfBlock ?? (checkpoint === undefined ? null : Number(checkpoint));
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (asOfBlock !== null) {
      conditions.push("block_height <= ?");
      values.push(asOfBlock);
    }
    if (query.q) {
      // Match `%` and `_` in the query literally, not as wildcards.
      const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        "(name LIKE ? ESCAPE '\\' OR symbol LIKE ? ESCAPE '\\' OR address = ?)",
      );
      values.push(pattern, pattern, query.q);
    }
    if (query.creator) {
      conditions.push("creator = ?");
      values.push(query.creator);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(
        `SELECT * FROM tokens ${where}
         ORDER BY block_height DESC, transaction_hash DESC, sequence_number DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit + 1, query.offset) as Record<string, unknown>[];
    return {
      tokens: rows.slice(0, query.limit).map((row) => ({
        address: String(row.address),
        creator: String(row.creator),
        name: row.name === null ? null : String(row.name),
        symbol: row.symbol === null ? null : String(row.symbol),
        decimals: row.decimals === null ? null : Number(row.decimals),
        initialSupply: String(row.initial_supply),
        blockHeight: String(row.block_height),
        transactionHash: String(row.transaction_hash),
      })),
      hasMore: rows.length > query.limit,
      asOfBlock: asOfBlock === null ? null : String(asOfBlock),
    };
  }

  close(): void {
    this.#db.close();
  }
}
