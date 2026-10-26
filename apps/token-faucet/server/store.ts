import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Claim, PublicConfig } from "../shared/config";
import type { Policy } from "./config";

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly status = 429,
    readonly retryAfter = 60,
  ) {
    super(message);
  }
}
export interface StoredClaim extends Claim {
  signed: string | null;
}
const DAY = 86400_000;
export class ClaimStore {
  private db: DatabaseSync;
  constructor(
    path: string,
    config: PublicConfig,
    private policy: Policy,
  ) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scope (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, recipient TEXT NOT NULL, ip TEXT NOT NULL,
        status TEXT NOT NULL, hash TEXT, signed TEXT, createdAt INTEGER NOT NULL, retryAt INTEGER NOT NULL,
        completedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS recipient_claims ON claims(recipient, createdAt);
      CREATE INDEX IF NOT EXISTS ip_claims ON claims(ip, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS pending_recipient ON claims(recipient) WHERE status IN ('reserved','pending');
      CREATE TABLE IF NOT EXISTS requests (ip TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
    `);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          network: config.networkId,
          height: config.anchorHeight,
          anchor: config.anchorHash,
          wallet: config.faucetAddress,
          tokens: config.tokens,
        }),
      )
      .digest("hex");
    const scope = this.db
      .prepare("SELECT fingerprint FROM scope WHERE id=1")
      .get();
    if (scope && scope.fingerprint !== fingerprint) {
      this.db.close();
      throw new Error(
        "Faucet database belongs to another deployment. Use a new database path.",
      );
    }
    this.db.prepare("INSERT OR IGNORE INTO scope VALUES(1,?)").run(fingerprint);
  }
  close() {
    this.db.close();
  }
  /** Only call at process startup, with one replica and no deployment overlap. */
  recoverUnsigned() {
    this.db.exec(
      "UPDATE claims SET status='failed',completedAt=createdAt WHERE status='reserved' AND signed IS NULL",
    );
  }
  get(id: string): StoredClaim | null {
    return (
      (this.db
        .prepare(
          "SELECT id,recipient,status,hash,signed,createdAt,retryAt FROM claims WHERE id=?",
        )
        .get(id) as unknown as StoredClaim | undefined) ?? null
    );
  }
  pending(): StoredClaim[] {
    return this.db
      .prepare(
        "SELECT id,recipient,status,hash,signed,createdAt,retryAt FROM claims WHERE status IN ('reserved','pending') ORDER BY createdAt LIMIT 100",
      )
      .all() as unknown as StoredClaim[];
  }
  pendingFor(recipient: string): StoredClaim | null {
    const row = this.db
      .prepare(
        "SELECT id FROM claims WHERE recipient=? AND status IN ('reserved','pending')",
      )
      .get(recipient);
    return row ? this.get(String(row.id)) : null;
  }
  countPending(): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM claims WHERE status IN ('reserved','pending')",
        )
        .get()!.n,
    );
  }
  rateLimit(ip: string, now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM requests WHERE start <= ?")
        .run(now - 60_000);
      const row = this.db
        .prepare("SELECT count, start FROM requests WHERE ip=?")
        .get(ip);
      if (row && Number(row.count) >= this.policy.requestsPerMinute)
        throw new ClaimError(
          "Too many requests. Try again shortly.",
          429,
          Math.max(1, Math.ceil((Number(row.start) + 60_000 - now) / 1000)),
        );
      if (
        !row &&
        Number(
          this.db.prepare("SELECT count(*) AS n FROM requests").get()!.n,
        ) >= this.policy.maxRecords
      )
        throw new ClaimError("Faucet is busy. Try again shortly.");
      this.db
        .prepare(
          "INSERT INTO requests VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=count+1",
        )
        .run(ip, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reserve(
    id: string,
    recipient: string,
    ip: string,
    now = Date.now(),
  ): { claim: StoredClaim; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.get(id);
      if (existing) {
        if (existing.recipient !== recipient)
          throw new ClaimError("Request ID belongs to another recipient.", 409);
        this.db.exec("COMMIT");
        return { claim: existing, created: false };
      }
      const active = this.pendingFor(recipient);
      if (active) {
        this.db.exec("COMMIT");
        return { claim: active, created: false };
      }
      if (this.countPending() >= 100)
        throw new ClaimError(
          "Faucet has too many pending claims. Try again later.",
          503,
        );
      const recent = this.db
        .prepare("SELECT max(retryAt) AS retryAt FROM claims WHERE recipient=?")
        .get(recipient);
      if (recent?.retryAt && Number(recent.retryAt) > now)
        throw new ClaimError(
          "This address is on cooldown.",
          429,
          Math.ceil((Number(recent.retryAt) - now) / 1000),
        );
      this.db
        .prepare(
          "DELETE FROM claims WHERE status IN ('confirmed','failed') AND retryAt < ? AND coalesce(completedAt,createdAt) < ?",
        )
        .run(now, now - 7 * DAY);
      const ipCount = this.db
        .prepare(
          "SELECT count(*) AS n FROM claims WHERE ip=? AND (createdAt>? OR completedAt>? OR status IN ('reserved','pending'))",
        )
        .get(ip, now - this.policy.ipWindowMs, now - this.policy.ipWindowMs)!;
      if (Number(ipCount.n) >= this.policy.ipClaims)
        throw new ClaimError(
          "This network has reached its hourly claim limit.",
          429,
          Math.ceil(this.policy.ipWindowMs / 1000),
        );
      const globalCount = this.db
        .prepare(
          "SELECT count(*) AS n FROM claims WHERE createdAt>? OR completedAt>? OR status IN ('reserved','pending')",
        )
        .get(now - DAY, now - DAY)!;
      if (Number(globalCount.n) >= this.policy.dailyClaims)
        throw new ClaimError(
          "The daily faucet limit has been reached.",
          429,
          86400,
        );
      if (
        Number(this.db.prepare("SELECT count(*) AS n FROM claims").get()!.n) >=
        this.policy.maxRecords
      )
        throw new ClaimError("Faucet history is full. Try again later.", 503);
      this.db
        .prepare(
          "INSERT INTO claims VALUES(?,?,?,'reserved',NULL,NULL,?,?,NULL)",
        )
        .run(id, recipient, ip, now, now + this.policy.cooldownMs);
      const claim = this.get(id)!;
      this.db.exec("COMMIT");
      return { claim, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  saveSigned(id: string, hash: string, signed: string) {
    const result = this.db
      .prepare(
        "UPDATE claims SET status='pending',hash=?,signed=? WHERE id=? AND status='reserved' AND signed IS NULL",
      )
      .run(hash, signed, id);
    if (result.changes !== 1)
      throw new Error("Claim changed before signing completed.");
  }
  finish(id: string, status: "confirmed" | "failed", now = Date.now()) {
    this.db
      .prepare(
        "UPDATE claims SET status=?,retryAt=max(retryAt,?),completedAt=? WHERE id=?",
      )
      .run(status, now + this.policy.cooldownMs, now, id);
  }
}
export function publicClaim(claim: StoredClaim): Claim {
  const { signed: _signed, ...result } = claim;
  return result;
}
