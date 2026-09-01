import type { DecodedTile } from "./inspection";

interface Job {
  id: number;
  bytes: ArrayBuffer;
  contentType: string;
  z: number;
  signal?: AbortSignal;
  abort?: () => void;
  resolve: (tile: DecodedTile) => void;
  reject: (error: unknown) => void;
}
export class TileWorkerPool {
  readonly size: number;
  private nextId = 1;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Job[] = [];
  private readonly running = new Map<number, { job: Job; worker: Worker }>();
  private closed = false;
  constructor(
    size = 2,
    private readonly factory: () => Worker = () =>
      new Worker(new URL("./tile-worker.ts", import.meta.url), {
        type: "module",
      }),
  ) {
    if (!Number.isInteger(size) || size < 1 || size > 2)
      throw new RangeError("worker pool size must be one or two");
    this.size = size;
    try {
      for (let index = 0; index < size; index += 1) {
        const worker = this.createWorker();
        this.workers.push(worker);
        this.idle.push(worker);
      }
    } catch (cause) {
      for (const worker of this.workers) this.dispose(worker);
      this.workers.length = 0;
      this.idle.length = 0;
      throw cause;
    }
  }
  decode(
    bytes: ArrayBuffer,
    contentType: string,
    z: number,
    signal?: AbortSignal,
  ): Promise<DecodedTile> {
    if (this.closed) return Promise.reject(new Error("worker pool is closed"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        bytes,
        contentType,
        z,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        const queued = this.queue.indexOf(job);
        if (queued >= 0) this.queue.splice(queued, 1);
        const active = this.running.get(job.id);
        if (active) {
          this.running.delete(job.id);
          this.dispose(active.worker);
        }
        this.cleanup(job);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (active) this.replace(active.worker);
      };
      job.abort = abort;
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  close(): void {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.cleanup(job);
      job.reject(new Error("worker pool closed"));
    }
    for (const { job } of this.running.values()) {
      this.cleanup(job);
      job.reject(new Error("worker pool closed"));
    }
    this.running.clear();
    for (const worker of this.workers) this.dispose(worker);
    this.workers.length = 0;
    this.idle.length = 0;
  }
  private drain(): void {
    while (!this.closed && this.idle.length && this.queue.length) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      if (job.signal?.aborted) {
        this.cleanup(job);
        job.reject(job.signal.reason);
        this.idle.push(worker);
        continue;
      }
      this.running.set(job.id, { job, worker });
      try {
        worker.postMessage(
          {
            id: job.id,
            bytes: job.bytes,
            contentType: job.contentType,
            z: job.z,
          },
          [job.bytes],
        );
      } catch (cause) {
        this.running.delete(job.id);
        this.cleanup(job);
        job.reject(cause);
        this.dispose(worker);
        this.replace(worker);
      }
    }
  }
  private complete(
    worker: Worker,
    data: { id: number; tile?: DecodedTile; error?: string },
  ): void {
    const active = this.running.get(data.id);
    if (!active || active.worker !== worker) return;
    this.running.delete(data.id);
    this.cleanup(active.job);
    this.idle.push(worker);
    if (data.error) active.job.reject(new Error(data.error));
    else if (data.tile) active.job.resolve(data.tile);
    else active.job.reject(new Error("worker returned no tile"));
    this.drain();
  }
  private replace(worker: Worker): void {
    const index = this.workers.indexOf(worker);
    if (index < 0 || this.closed) return;
    try {
      const replacement = this.createWorker();
      this.workers[index] = replacement;
      this.idle.push(replacement);
      this.drain();
    } catch (cause) {
      this.workers.splice(index, 1);
      const error = new Error("Tile worker replacement failed", { cause });
      if (this.workers.length === 0) {
        this.closed = true;
        this.rejectQueued(error);
      } else {
        this.drain();
      }
    }
  }
  private createWorker(): Worker {
    const worker = this.factory();
    worker.onmessage = (
      event: MessageEvent<{ id: number; tile?: DecodedTile; error?: string }>,
    ) => this.complete(worker, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.failWorker(
        worker,
        new Error(event.message || "Tile worker crashed"),
      );
    };
    worker.onmessageerror = () =>
      this.failWorker(
        worker,
        new Error("Tile worker returned an invalid message"),
      );
    return worker;
  }
  private failWorker(worker: Worker, cause: Error): void {
    const active = [...this.running.values()].find(
      (entry) => entry.worker === worker,
    );
    if (active) {
      this.running.delete(active.job.id);
      this.cleanup(active.job);
      active.job.reject(cause);
    }
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    this.dispose(worker);
    this.replace(worker);
  }
  private cleanup(job: Job): void {
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
  }
  private rejectQueued(cause: Error): void {
    for (const job of this.queue.splice(0)) {
      this.cleanup(job);
      job.reject(cause);
    }
  }
  private dispose(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
}
