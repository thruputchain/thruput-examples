import { describe, expect, test } from "vitest";
import { TileWorkerPool } from "./worker-pool";
import type { DecodedTile } from "./inspection";

class FakeWorker {
  onmessage:
    | ((
        event: MessageEvent<{ id: number; tile?: DecodedTile; error?: string }>,
      ) => void)
    | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  jobs: Array<{ id: number }> = [];
  postMessage(job: { id: number }): void {
    this.jobs.push(job);
  }
  terminate(): void {
    this.terminated = true;
  }
  finish(
    tile: DecodedTile = { kind: "density", values: new Uint16Array(1) },
  ): void {
    const job = this.jobs.shift();
    if (job) this.onmessage?.({ data: { id: job.id, tile } } as MessageEvent);
  }
  crash(): void {
    this.onerror?.({
      message: "decode crashed",
      preventDefault() {},
    } as ErrorEvent);
  }
}

describe("two-worker decode pool", () => {
  test("refuses more than two workers", () =>
    expect(() => new TileWorkerPool(3)).toThrow(/one or two/));
  test("runs at most two jobs and queues the third", async () => {
    const workers: FakeWorker[] = [];
    const pool = new TileWorkerPool(2, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const jobs = [0, 1, 2].map(() => pool.decode(new ArrayBuffer(1), "x", 0));
    expect(workers[0]!.jobs.length + workers[1]!.jobs.length).toBe(2);
    workers[1]!.finish();
    await jobs[0];
    expect(workers[0]!.jobs.length + workers[1]!.jobs.length).toBe(2);
    workers[0]!.finish();
    workers[1]!.finish();
    await Promise.all(jobs);
    pool.close();
    expect(workers.slice(0, 2).every((worker) => worker.terminated)).toBe(true);
  });
  test("propagates abort, terminates active work, and replaces its worker", async () => {
    const workers: FakeWorker[] = [];
    const pool = new TileWorkerPool(1, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const controller = new AbortController();
    const result = pool.decode(new ArrayBuffer(1), "x", 0, controller.signal);
    controller.abort();
    await expect(result).rejects.toBeDefined();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    pool.close();
  });
  test("rejects crashed work and replaces the failed worker", async () => {
    const workers: FakeWorker[] = [];
    const pool = new TileWorkerPool(1, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const result = pool.decode(new ArrayBuffer(1), "x", 0);
    workers[0]!.crash();
    await expect(result).rejects.toThrow(/decode crashed/);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    pool.close();
  });
  test("rejects active and queued jobs when the only replacement factory fails", async () => {
    const worker = new FakeWorker();
    let calls = 0;
    const pool = new TileWorkerPool(1, () => {
      calls += 1;
      if (calls > 1) throw new Error("factory unavailable");
      return worker as unknown as Worker;
    });
    const activeController = new AbortController();
    const active = pool.decode(
      new ArrayBuffer(1),
      "x",
      0,
      activeController.signal,
    );
    const queued = pool.decode(new ArrayBuffer(1), "x", 0);
    expect(() => activeController.abort()).not.toThrow();
    await expect(active).rejects.toBeDefined();
    await expect(queued).rejects.toThrow(/replacement failed/);
    await expect(pool.decode(new ArrayBuffer(1), "x", 0)).rejects.toThrow(
      /closed/,
    );
    expect(worker.terminated).toBe(true);
    pool.close();
  });

  test("contains replacement failure from a worker crash", async () => {
    const worker = new FakeWorker();
    let calls = 0;
    const pool = new TileWorkerPool(1, () => {
      calls += 1;
      if (calls > 1) throw new Error("factory unavailable");
      return worker as unknown as Worker;
    });
    const active = pool.decode(new ArrayBuffer(1), "x", 0);
    expect(() => worker.crash()).not.toThrow();
    await expect(active).rejects.toThrow(/decode crashed/);
    await expect(pool.decode(new ArrayBuffer(1), "x", 0)).rejects.toThrow(
      /closed/,
    );
    pool.close();
  });
});
