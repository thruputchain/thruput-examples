import { errorMessage } from "../config";

export type Direction = "increment" | "decrement";
type TransactionState =
  "queued" | "signing" | "pending" | "confirmed" | "failed" | "unknown";
export interface Transaction {
  id: number;
  direction: Direction;
  state: TransactionState;
  hash: string | null;
  message: string | null;
}
export interface Snapshot {
  ready: boolean;
  message: string;
  value: bigint | null;
  signerBalance: bigint | null;
  updatedAt: number | null;
  submitted: number;
  confirmed: number;
  failed: number;
  pending: number;
  unknown: number;
  skipped: number;
  atCapacity: boolean;
  rate: number;
  recent: Transaction[];
}
export const initialSnapshot: Snapshot = {
  ready: false,
  message: "Connecting to Thruput…",
  value: null,
  signerBalance: null,
  updatedAt: null,
  submitted: 0,
  confirmed: 0,
  failed: 0,
  pending: 0,
  unknown: 0,
  skipped: 0,
  atCapacity: false,
  rate: 0,
  recent: [],
};
interface PreparedTransaction {
  hash: string;
  submit(): Promise<void>;
}
export type Observation =
  | { state: "pending" }
  | { state: "confirmed" | "failed"; message: string | null };
export interface CounterConnection {
  read(): Promise<{ value: bigint | null; signerBalance: bigint }>;
  prepare(direction: Direction): Promise<PreparedTransaction>;
  observe(hash: string): Promise<Observation>;
  dispose(): void;
}
interface TrackedTransaction extends Transaction {
  submittedAt: number;
  nextPoll: number;
  observing: boolean;
}

const SUBMISSIONS = 16;
const OBSERVATIONS = 16;
const CAPACITY = 512;
const UNKNOWN_AFTER_MS = 20_000;

// One bounded scheduler, independent of React and of receipt latency.
export class TransactionEngine {
  private state = { ...initialSnapshot };
  private outstanding = new Map<number, TrackedTransaction>();
  private recent: Transaction[] = [];
  private completions: number[] = [];
  private nextId = 0;
  private submitting = 0;
  private observing = 0;
  private reading = false;
  private nextRead = 0;
  private stopped = false;
  private accepting = true;
  private acceptanceRevision = 0;

  constructor(
    private connection: CounterConnection,
    private now = Date.now,
  ) {}

  enqueue(direction: Direction): boolean {
    if (this.stopped || !this.accepting) return false;
    if (!this.state.ready || this.outstanding.size >= CAPACITY) {
      this.state.skipped++;
      return false;
    }
    const transaction: TrackedTransaction = {
      id: ++this.nextId,
      direction,
      state: "queued",
      hash: null,
      message: null,
      submittedAt: 0,
      nextPoll: 0,
      observing: false,
    };
    this.outstanding.set(transaction.id, transaction);
    this.recent = [transaction, ...this.recent].slice(0, 12);
    this.pump();
    return true;
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    if (this.state.updatedAt !== null && now - this.state.updatedAt > 5_000) {
      this.state.ready = false;
      this.state.signerBalance = null;
      this.state.message = "Connection delayed. New transactions are paused.";
    }
    if (!this.reading && now >= this.nextRead) void this.refresh();
    for (const transaction of this.outstanding.values()) {
      if (transaction.hash === null || transaction.state === "signing")
        continue;
      if (now - transaction.submittedAt >= UNKNOWN_AFTER_MS) {
        transaction.state = "unknown";
        transaction.message ??=
          "Confirmation delayed. Still checking this hash.";
      }
      if (
        this.observing < OBSERVATIONS &&
        !transaction.observing &&
        now >= transaction.nextPoll
      ) {
        void this.observe(transaction);
      }
    }
    this.pump();
  }

  snapshot(): Snapshot {
    const now = this.now();
    this.completions = this.completions.filter((time) => now - time < 5_000);
    let unknown = 0;
    for (const transaction of this.outstanding.values()) {
      if (transaction.state === "unknown") unknown++;
    }
    return {
      ...this.state,
      pending: this.outstanding.size - unknown,
      unknown,
      atCapacity: this.outstanding.size >= CAPACITY,
      rate: this.completions.length / 5,
      recent: this.recent.map(({ id, direction, state, hash, message }) => ({
        id,
        direction,
        state,
        hash,
        message,
      })),
    };
  }

  stop(): void {
    this.stopped = true;
    this.connection.dispose();
  }

  // Pause new work without abandoning hashes that may already be on chain.
  setAccepting(accepting: boolean): void {
    if (this.accepting && !accepting) this.acceptanceRevision++;
    this.accepting = accepting;
    if (!accepting) {
      for (const transaction of this.outstanding.values()) {
        if (transaction.state === "queued") {
          this.finish(transaction, "failed", "Not sent: signing mode changed.");
        }
      }
    } else {
      this.pump();
    }
  }

  private async refresh(): Promise<void> {
    this.reading = true;
    try {
      const { value, signerBalance } = await this.connection.read();
      if (this.stopped) return;
      this.state.value = value;
      this.state.signerBalance = signerBalance;
      this.state.updatedAt = this.now();
      this.state.ready = signerBalance > 0n;
      this.state.message = this.state.ready
        ? "Ready"
        : "The signer needs test HOG. Use Top up Signer to continue.";
    } catch (error) {
      if (this.stopped) return;
      this.state.ready = false;
      this.state.signerBalance = null;
      this.state.message = errorMessage(error);
    } finally {
      // Unsent inputs must not unexpectedly fire when an outage ends.
      if (!this.state.ready && !this.stopped) {
        for (const transaction of this.outstanding.values()) {
          if (transaction.state === "queued")
            this.finish(transaction, "failed", "Not sent: signer unavailable.");
        }
      }
      this.reading = false;
      this.nextRead =
        this.now() +
        (this.state.ready && this.outstanding.size > 0 ? 500 : 2_000);
    }
  }

  private pump(): void {
    if (this.stopped || !this.accepting || !this.state.ready) return;
    for (const transaction of this.outstanding.values()) {
      if (this.submitting >= SUBMISSIONS) break;
      if (transaction.state === "queued") void this.submit(transaction);
    }
  }

  private async submit(transaction: TrackedTransaction): Promise<void> {
    const revision = this.acceptanceRevision;
    transaction.state = "signing";
    this.submitting++;
    try {
      const prepared = await this.connection.prepare(transaction.direction);
      if (this.stopped) return;
      if (!this.accepting || revision !== this.acceptanceRevision) {
        this.finish(transaction, "failed", "Not sent: signing mode changed.");
        return;
      }
      if (!this.state.ready) {
        this.finish(transaction, "failed", "Not sent: connection unavailable.");
        return;
      }
      transaction.hash = prepared.hash;
      transaction.submittedAt = this.now();
      this.state.submitted++;
      // Remain in signing state until send settles, so an observation cannot
      // race the send response and then get overwritten by it.
      try {
        await prepared.submit();
        transaction.state = "pending";
      } catch {
        transaction.state = "unknown";
        transaction.message =
          "Send response unavailable. Checking the original hash.";
      }
      transaction.nextPoll = this.now();
      this.nextRead = Math.min(this.nextRead, this.now() + 500);
    } catch (error) {
      this.finish(transaction, "failed", errorMessage(error));
    } finally {
      this.submitting--;
      this.pump();
    }
  }

  private async observe(transaction: TrackedTransaction): Promise<void> {
    transaction.observing = true;
    this.observing++;
    try {
      const outcome = await this.connection.observe(transaction.hash!);
      if (this.stopped) return;
      if (outcome.state !== "pending")
        this.finish(transaction, outcome.state, outcome.message);
    } catch {
      transaction.state = "unknown";
      transaction.message = "Receipt unavailable. Still checking this hash.";
    } finally {
      transaction.nextPoll =
        this.now() + (transaction.state === "unknown" ? 5_000 : 500);
      transaction.observing = false;
      this.observing--;
    }
  }

  private finish(
    transaction: TrackedTransaction,
    state: "confirmed" | "failed",
    message: string | null,
  ): void {
    if (this.stopped || !this.outstanding.delete(transaction.id)) return;
    transaction.state = state;
    transaction.message = message;
    this.state[state]++;
    if (state === "confirmed") this.completions.push(this.now());
  }
}
