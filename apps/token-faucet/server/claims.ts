import { ClaimError, ClaimStore, publicClaim } from "./store";
import type { ClaimChain } from "./chain";
import type { PublicConfig } from "../shared/config";

export class Claims {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private available = { balances: [] as string[], packs: 0, checkedAt: 0 };
  constructor(
    readonly config: PublicConfig,
    readonly store: ClaimStore,
    private chain: ClaimChain,
  ) {}
  async start() {
    await this.refresh();
    this.store.recoverUnsigned();
    this.timer = setInterval(() => {
      void this.tick();
    }, 3_000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    clearInterval(this.timer);
    await this.running;
  }
  publicConfig() {
    const fresh = Date.now() - this.available.checkedAt < 60_000;
    return {
      ...this.config,
      balances: this.available.balances,
      available: fresh && this.available.packs > this.store.countPending(),
    };
  }
  claim(id: string, recipient: string, ip: string) {
    // Returning existing evidence remains possible when the chain is offline.
    const existing = this.store.get(id);
    if (existing) {
      if (existing.recipient !== recipient)
        throw new ClaimError("Request ID belongs to another recipient.", 409);
      return publicClaim(existing);
    }
    const pending = this.store.pendingFor(recipient);
    if (pending) return publicClaim(pending);
    if (!this.publicConfig().available)
      throw new ClaimError(
        "Faucet is temporarily unavailable. Check back shortly.",
        503,
      );
    const { claim } = this.store.reserve(id, recipient, ip);
    void this.tick();
    return publicClaim(claim);
  }
  private async refresh() {
    await this.chain.check();
    const inventory = await this.chain.inventory();
    this.available = { ...inventory, checkedAt: Date.now() };
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.process()
      .catch(() => {
        this.available.checkedAt = 0;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async process() {
    for (const claim of this.store.pending()) {
      if (claim.status === "reserved") {
        try {
          const prepared = await this.chain.prepare(claim.recipient);
          // FULL synchronous SQLite commit must succeed before any broadcast.
          this.store.saveSigned(claim.id, prepared.hash, prepared.signed);
          await prepared.broadcast();
        } catch {
          const saved = this.store.get(claim.id)!;
          if (!saved.signed) this.store.finish(claim.id, "failed");
          // A timeout or crash after persistence is uncertain. Observe the hash;
          // never generate or submit a replacement automatically.
          this.available.checkedAt = 0;
        }
      }
      const saved = this.store.get(claim.id)!;
      if (saved.status === "pending" && saved.hash) {
        try {
          const result = await this.chain.observe(saved.hash);
          if (result !== "pending") this.store.finish(saved.id, result);
        } catch {
          this.available.checkedAt = 0;
        }
      }
    }
    await this.refresh();
  }
}
