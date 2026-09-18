import type { SyncController } from "../shared/registry.ts";
import {
  RegistryCursorRejectedError,
  RegistryIntegrityError,
  type RegistrySource,
  type RegistrySourcePage,
} from "./chain.ts";
import {
  ImmutableRegistryConflictError,
  RegistryScopeMismatchError,
  RegistryStore,
  RegistryStoreError,
} from "./store.ts";
import { ValidationError } from "./validation.ts";

export interface RegistryIndexerOptions {
  pageSize: number;
  syncIntervalMs: number;
  requestCooldownMs?: number;
  maximumRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export class RegistryIndexer implements SyncController {
  readonly #store: RegistryStore;
  readonly #source: RegistrySource;
  readonly #options: Required<RegistryIndexerOptions>;
  #active: Promise<void> | null = null;
  #abortController: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending = false;
  #lastPublicRequestAt = Number.NEGATIVE_INFINITY;
  #stopped = false;
  #integrityFault = false;

  constructor(
    store: RegistryStore,
    source: RegistrySource,
    options: RegistryIndexerOptions,
  ) {
    this.#store = store;
    this.#source = source;
    this.#options = {
      requestCooldownMs: 1_000,
      maximumRetries: 3,
      retryDelayMs: (attempt) => Math.min(250 * 2 ** (attempt - 1), 2_000),
      sleep: abortableSleep,
      now: () => new Date(),
      ...options,
    };
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#schedule();
    this.#timer = setInterval(
      () => this.#schedule(),
      this.#options.syncIntervalMs,
    );
    this.#timer.unref?.();
  }

  requestSync(): void {
    const now = this.#options.now().valueOf();
    if (now - this.#lastPublicRequestAt < this.#options.requestCooldownMs)
      return;
    this.#lastPublicRequestAt = now;
    this.#schedule();
  }

  async sync(): Promise<void> {
    this.#schedule();
    await this.#active;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return this.#active ?? Promise.resolve();
    this.#stopped = true;
    this.#pending = false;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#abortController?.abort(new Error("Registry indexer stopped"));
    await this.#active;
  }

  #schedule(): void {
    if (this.#stopped || this.#integrityFault) return;
    if (this.#active !== null) {
      this.#pending = true;
      return;
    }
    this.#abortController = new AbortController();
    this.#active = this.#drain(this.#abortController.signal).finally(() => {
      this.#active = null;
      this.#abortController = null;
    });
  }

  async #drain(signal: AbortSignal): Promise<void> {
    do {
      this.#pending = false;
      await this.#run(signal);
    } while (
      this.#pending &&
      !this.#stopped &&
      !this.#integrityFault &&
      !signal.aborted
    );
  }

  async #run(signal: AbortSignal): Promise<void> {
    try {
      this.#store.updateStatus({ syncState: "syncing", lastError: null });
      await this.#scanWithRetries(signal);
      if (signal.aborted) return;
      this.#store.updateStatus({
        syncState: "idle",
        lastSuccessfulSyncAt: this.#options.now().toISOString(),
        lastError: null,
      });
    } catch (error) {
      if (signal.aborted) {
        this.#store.updateStatus({ syncState: "idle" });
        return;
      }
      if (isIntegrityFault(error)) {
        this.#integrityFault = true;
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
        this.#store.updateStatus({
          syncState: "integrityFault",
          lastError: publicError(error),
        });
        return;
      }
      this.#store.updateStatus({
        syncState: "idle",
        lastError: publicError(error),
      });
    }
  }

  async #scanWithRetries(signal: AbortSignal): Promise<void> {
    let failures = 0;
    for (;;) {
      try {
        await this.#scan(signal);
        return;
      } catch (error) {
        if (signal.aborted || isIntegrityFault(error)) throw error;
        failures += 1;
        if (failures > this.#options.maximumRetries) throw error;
        this.#store.updateStatus({
          syncState: "retrying",
          lastError: publicError(error),
        });
        await this.#options.sleep(this.#options.retryDelayMs(failures), signal);
        this.#store.updateStatus({ syncState: "syncing" });
      }
    }
  }

  async #scan(signal: AbortSignal): Promise<void> {
    await this.#source.verifyNetworkIdentity(signal);
    let scan = this.#store.getScan();
    let anchorBlock =
      scan?.anchorBlock ??
      (BigInt(this.#store.getStatus().indexedThroughBlock) + 1n).toString();
    let cursor = scan?.nextCursor ?? null;
    const seenCursors = new Set<string>();
    let rejectedCursorReplayed = false;

    for (;;) {
      let page: RegistrySourcePage;
      try {
        page = await this.#source.getPage({
          anchorBlock,
          cursor,
          limit: this.#options.pageSize,
          signal,
        });
      } catch (error) {
        if (error instanceof RegistryCursorRejectedError && cursor !== null) {
          if (rejectedCursorReplayed) throw error;
          rejectedCursorReplayed = true;
          this.#store.resetScanCursor();
          cursor = null;
          seenCursors.clear();
          continue;
        }
        throw error;
      }

      if (cursor === null && BigInt(page.oldestBlock) > BigInt(anchorBlock)) {
        this.#store.updateStatus({ historyLimited: true });
      }

      if (scan === null) {
        if (BigInt(page.latestBlock) < BigInt(anchorBlock)) return;
        this.#store.beginScan(anchorBlock, page.latestBlock);
        scan = this.#store.getScan();
        if (scan === null)
          throw new RegistryIntegrityError("Scan did not begin");
      }

      const beyondTarget = page.tokens.some(
        ({ blockHeight }) => BigInt(blockHeight) > BigInt(scan!.targetBlock),
      );
      const tokens = page.tokens.filter(
        ({ blockHeight }) => BigInt(blockHeight) <= BigInt(scan!.targetBlock),
      );
      const nextCursor = beyondTarget ? null : page.nextCursor;
      if (nextCursor !== null) {
        if (nextCursor === cursor || seenCursors.has(nextCursor)) {
          throw new RegistryIntegrityError("RPC repeated an event page cursor");
        }
        seenCursors.add(nextCursor);
      }
      await this.#source.verifyNetworkIdentity(signal);
      signal.throwIfAborted();
      this.#store.commitPage(tokens, nextCursor);
      if (nextCursor === null) return;
      cursor = nextCursor;
      anchorBlock = scan.anchorBlock;
    }
  }
}

function isIntegrityFault(error: unknown): boolean {
  return (
    error instanceof RegistryIntegrityError ||
    error instanceof ImmutableRegistryConflictError ||
    error instanceof RegistryScopeMismatchError ||
    error instanceof ValidationError
  );
}

function publicError(error: unknown): string {
  if (
    error instanceof RegistryIntegrityError ||
    error instanceof RegistryCursorRejectedError ||
    error instanceof ValidationError ||
    error instanceof RegistryStoreError
  ) {
    return error.message;
  }
  return "Registry synchronization is temporarily unavailable";
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
