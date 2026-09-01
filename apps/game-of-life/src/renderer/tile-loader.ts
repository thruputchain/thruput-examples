import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import { CELLS_CONTENT_TYPE, DENSITY_CONTENT_TYPE } from "@/indexer/schema";
import {
  ByteBudget,
  DEFAULT_CPU_BUDGET,
  SHARED_CPU_CACHE_BUDGET,
} from "./budget";
import type { DecodedTile } from "./inspection";
import { tileId, type TileIndex } from "./pyramid";
import { TileWorkerPool } from "./worker-pool";

export interface LoadedTileData {
  readonly availability: "loaded";
  readonly byteLength: number;
  readonly digest: string;
  readonly index: TileIndex;
  readonly tile: DecodedTile;
}
export interface MissingTileData {
  readonly availability: "missing";
  readonly byteLength: number;
  readonly digest: string;
  readonly index: TileIndex;
}
export type TileData = LoadedTileData | MissingTileData;
export interface TileResources {
  readonly cache: ByteBudget<TileData>;
  readonly requests: ConcurrencyGate;
  readonly prefetchRequests: ConcurrencyGate;
  readonly pool: TileWorkerPool;
}

export function createTileResources(
  budget = SHARED_CPU_CACHE_BUDGET,
): TileResources {
  return {
    cache: new ByteBudget(budget),
    requests: new ConcurrencyGate(7),
    prefetchRequests: new ConcurrencyGate(1),
    pool: new TileWorkerPool(2),
  };
}
interface InFlightTile {
  readonly controller: AbortController;
  promise: Promise<TileData>;
  consumers: number;
  settled: boolean;
}
export class TileLoader {
  readonly cache: ByteBudget<TileData>;
  private readonly inFlight = new Map<string, InFlightTile>();
  private readonly requests: ConcurrencyGate;
  private readonly prefetchRequests: ConcurrencyGate;
  private readonly pool: Pick<TileWorkerPool, "decode" | "close">;
  private readonly ownsResources: boolean;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly client: IndexerClient,
    private readonly snapshot: ImmutableSnapshot,
    pool: Pick<TileWorkerPool, "decode" | "close"> | undefined = undefined,
    private readonly fetcher: typeof fetch = (...args) =>
      globalThis.fetch(...args),
    budget = DEFAULT_CPU_BUDGET,
    resources?: TileResources,
  ) {
    this.ownsResources = resources === undefined;
    this.pool = resources?.pool ?? pool ?? new TileWorkerPool(2);
    this.cache = resources?.cache ?? new ByteBudget(budget);
    this.requests = resources?.requests ?? new ConcurrencyGate(7);
    this.prefetchRequests =
      resources?.prefetchRequests ?? new ConcurrencyGate(1);
  }
  load(index: TileIndex, signal?: AbortSignal): Promise<TileData> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = `${this.snapshot.manifest.stateDigest}:${tileId(index)}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.inFlight.get(key);
    if (existing) return this.consume(key, existing, signal);
    const entry = this.start(index, key, this.requests);
    return this.consume(key, entry, signal);
  }
  private start(
    index: TileIndex,
    key: string,
    gate: ConcurrencyGate,
  ): InFlightTile {
    const controller = new AbortController();
    const effectiveSignal = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
    ]);
    const entry = {
      controller,
      consumers: 0,
      settled: false,
    } as InFlightTile;
    entry.promise = this.fetchDecode(index, effectiveSignal, gate)
      .then((data) => {
        this.cache.set(key, data, data.byteLength);
        return data;
      })
      .finally(() => {
        entry.settled = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      });
    this.inFlight.set(key, entry);
    return entry;
  }
  close(): void {
    this.lifetime.abort(new DOMException("Tile loader closed", "AbortError"));
    if (this.ownsResources) {
      this.pool.close();
      this.cache.clear();
    }
  }
  pin(indices: readonly TileIndex[]): void {
    for (const index of indices)
      this.cache.pin(`${this.snapshot.manifest.stateDigest}:${tileId(index)}`);
  }
  unpin(indices: readonly TileIndex[]): void {
    for (const index of indices)
      this.cache.unpin(
        `${this.snapshot.manifest.stateDigest}:${tileId(index)}`,
      );
  }
  purge(): void {
    this.cache.deletePrefix(`${this.snapshot.manifest.stateDigest}:`);
  }
  async prefetch(
    indices: readonly TileIndex[],
    signal: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = AbortSignal.any([signal, this.lifetime.signal]);
    for (const index of indices) {
      effectiveSignal.throwIfAborted();
      const key = `${this.snapshot.manifest.stateDigest}:${tileId(index)}`;
      if (this.cache.get(key)) continue;
      const entry =
        this.inFlight.get(key) ?? this.start(index, key, this.prefetchRequests);
      await this.consume(key, entry, effectiveSignal);
    }
  }
  private async fetchDecode(
    index: TileIndex,
    signal: AbortSignal,
    gate: ConcurrencyGate,
  ): Promise<TileData> {
    let result: { bytes: ArrayBuffer; contentType: string };
    try {
      result = await this.fetchBytes(index, signal, gate);
    } catch (cause) {
      if (cause instanceof TileUnavailableError)
        return {
          availability: "missing",
          byteLength: 64,
          digest: this.snapshot.manifest.stateDigest,
          index,
        };
      throw cause;
    }
    const { bytes, contentType } = result;
    const tile = await this.pool.decode(bytes, contentType, index.z, signal);
    const byteLength =
      tile.kind === "cells"
        ? tile.packed.byteLength + tile.values.byteLength
        : tile.values.byteLength;
    return {
      availability: "loaded",
      byteLength,
      digest: this.snapshot.manifest.stateDigest,
      index,
      tile,
    };
  }
  private async fetchBytes(
    index: TileIndex,
    signal: AbortSignal | undefined,
    gate: ConcurrencyGate,
  ): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const release = await gate.acquire(signal);
    try {
      const response = await this.fetcher(
        this.client.tileUrl(this.snapshot, index.z, index.x, index.y),
        {
          headers: {
            accept: index.z === 6 ? CELLS_CONTENT_TYPE : DENSITY_CONTENT_TYPE,
          },
          redirect: "error",
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) {
        if (response.status === 404) throw new TileUnavailableError();
        throw new Error(`Tile request failed (${response.status})`);
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      const expected =
        index.z === 6 ? CELLS_CONTENT_TYPE : DENSITY_CONTENT_TYPE;
      if (contentType !== expected)
        throw new Error(
          `Unexpected tile content type: ${contentType ?? "missing"}`,
        );
      const expectedLength = index.z === 6 ? 8192 : 131072;
      const declaredLength = response.headers.get("content-length");
      const contentEncoding = response.headers.get("content-encoding");
      if (
        declaredLength !== null &&
        contentEncoding === null &&
        (!/^\d+$/.test(declaredLength) ||
          Number(declaredLength) !== expectedLength)
      )
        throw new Error("Unexpected tile content length");
      const bytes = await readExactBody(response, expectedLength, signal);
      return { bytes, contentType };
    } finally {
      release();
    }
  }
  private consume(
    key: string,
    entry: InFlightTile,
    signal?: AbortSignal,
  ): Promise<TileData> {
    entry.consumers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        entry.consumers -= 1;
        if (entry.consumers === 0 && !entry.settled) {
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
          entry.controller.abort(
            new DOMException("All tile consumers aborted", "AbortError"),
          );
        }
        return true;
      };
      const abort = () => {
        if (finish())
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (cause) => {
          if (finish()) reject(cause);
        },
      );
    });
  }
}

class TileUnavailableError extends Error {
  constructor() {
    super("Tile unavailable");
    this.name = "TileUnavailableError";
  }
}

async function readExactBody(
  response: Response,
  expectedLength: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("Tile response body is missing");
  const reader = response.body.getReader();
  const output = new Uint8Array(expectedLength);
  let offset = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedLength)
        throw new Error("Unexpected decoded tile length");
      output.set(value, offset);
      offset += value.byteLength;
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    throw cause;
  }
  if (offset !== expectedLength)
    throw new Error("Unexpected decoded tile length");
  return output.buffer;
}

export class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("concurrency limit must be positive");
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      } as (typeof this.queue)[number];
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift()!;
      entry.signal?.removeEventListener("abort", entry.abort!);
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      this.active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      });
    }
  }
}
