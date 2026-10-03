import { describe, expect, it, vi } from "vitest";
import {
  TransactionEngine,
  type CounterConnection,
  type Observation,
} from "./engine";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}
async function fixture() {
  let time = 1_000;
  let nonce = 0;
  const submit = vi.fn(async () => {});
  const connection = {
    read: vi.fn<CounterConnection["read"]>(async () => ({
      value: 1_000_000n,
      signerBalance: 100_000_000n,
    })),
    prepare: vi.fn(async () => ({ hash: `hash-${++nonce}`, submit })),
    observe: vi.fn(async (): Promise<Observation> => ({ state: "pending" })),
    dispose: vi.fn(),
  } satisfies CounterConnection;
  const engine = new TransactionEngine(connection, () => time);
  engine.tick();
  await flush();
  return {
    engine,
    connection,
    submit,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("transaction engine", () => {
  it("pauses unsent work while continuing to observe submitted hashes", async () => {
    const { engine, connection, submit } = await fixture();
    engine.enqueue("increment");
    await flush();
    engine.setAccepting(false);
    expect(engine.enqueue("decrement")).toBe(false);
    connection.observe.mockResolvedValue({ state: "confirmed", message: null });
    engine.tick();
    await flush();
    expect(engine.snapshot().confirmed).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
    engine.setAccepting(true);
    expect(engine.enqueue("increment")).toBe(true);
  });

  it("discards preparations from before a pause even after switching back", async () => {
    const { engine, connection, submit } = await fixture();
    const preparing = deferred<{ hash: string; submit: typeof submit }>();
    connection.prepare.mockImplementation(() => preparing.promise);
    for (let i = 0; i < 20; i++) engine.enqueue("increment");
    engine.setAccepting(false);
    engine.setAccepting(true);
    preparing.resolve({ hash: "old", submit });
    await flush();
    expect(submit).not.toHaveBeenCalled();
    expect(engine.snapshot()).toMatchObject({ failed: 20, submitted: 0, pending: 0 });
  });
  it("publishes the live signer balance and pauses writes at zero", async () => {
    const { engine, connection, advance } = await fixture();
    expect(engine.snapshot().signerBalance).toBe(100_000_000n);
    connection.read.mockResolvedValue({ value: 1_000_000n, signerBalance: 0n });
    advance(2_000);
    engine.tick();
    await flush();
    expect(engine.snapshot()).toMatchObject({
      ready: false,
      signerBalance: 0n,
    });
    expect(engine.enqueue("increment")).toBe(false);
    connection.read.mockResolvedValue({
      value: 1_000_000n,
      signerBalance: 200_000_000n,
    });
    advance(2_000);
    engine.tick();
    await flush();
    expect(engine.snapshot()).toMatchObject({
      ready: true,
      signerBalance: 200_000_000n,
    });
  });
  it("submits a burst without waiting for any receipt", async () => {
    const { engine, connection } = await fixture();
    for (let index = 0; index < 100; index++)
      expect(engine.enqueue(index % 2 ? "increment" : "decrement")).toBe(true);
    await flush();
    expect(engine.snapshot()).toMatchObject({
      submitted: 100,
      confirmed: 0,
      pending: 100,
    });
    expect(connection.observe).not.toHaveBeenCalled();
    expect(connection.read).toHaveBeenCalledTimes(1);
    expect(engine.snapshot().recent).toHaveLength(12);
  });

  it("bounds active send requests and total outstanding inputs", async () => {
    const { engine, submit, connection } = await fixture();
    const stalled = deferred<void>();
    submit.mockImplementation(() => stalled.promise);
    for (let index = 0; index < 600; index++) engine.enqueue("increment");
    await flush();
    expect(connection.prepare).toHaveBeenCalledTimes(16);
    expect(engine.snapshot()).toMatchObject({
      atCapacity: true,
      pending: 512,
      skipped: 88,
      submitted: 16,
    });
    stalled.resolve();
    await flush();
    expect(engine.snapshot().submitted).toBe(512);
  });

  it("observes a lost send response by its original hash without resending", async () => {
    const { engine, connection, submit, advance } = await fixture();
    submit.mockRejectedValueOnce(new Error("connection lost"));
    engine.enqueue("increment");
    await flush();
    expect(engine.snapshot()).toMatchObject({
      submitted: 1,
      unknown: 1,
      confirmed: 0,
    });
    connection.observe.mockResolvedValue({ state: "confirmed", message: null });
    engine.tick();
    await flush();
    expect(connection.observe).toHaveBeenCalledWith("hash-1");
    expect(engine.snapshot()).toMatchObject({
      confirmed: 1,
      unknown: 0,
      rate: 0.2,
    });
    advance(6_000);
    engine.tick();
    await flush();
    expect(engine.snapshot().rate).toBe(0);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps timed-out hashes unresolved and later records their actual outcome", async () => {
    const { engine, connection, advance } = await fixture();
    engine.enqueue("decrement");
    await flush();
    advance(21_000);
    engine.tick();
    await flush();
    expect(engine.snapshot()).toMatchObject({
      unknown: 1,
      confirmed: 0,
      failed: 0,
    });
    connection.observe.mockResolvedValue({
      state: "failed",
      message: "Non-negative integer underflow",
    });
    advance(5_000);
    engine.tick();
    await flush();
    expect(engine.snapshot()).toMatchObject({
      unknown: 0,
      pending: 0,
      failed: 1,
    });
    expect(engine.snapshot().recent[0]?.message).toContain("underflow");
  });

  it("bounds observation work and lets later hashes progress past slow receipts", async () => {
    const { engine, connection } = await fixture();
    const first = deferred<Observation>();
    connection.observe.mockImplementation(async (hash?: string) =>
      hash === "hash-1" ? first.promise : { state: "confirmed", message: null },
    );
    for (let index = 0; index < 50; index++) engine.enqueue("increment");
    await flush();
    engine.tick();
    expect(connection.observe).toHaveBeenCalledTimes(16);
    await flush();
    engine.tick();
    await flush();
    engine.tick();
    await flush();
    engine.tick();
    await flush();
    expect(engine.snapshot()).toMatchObject({ confirmed: 49, pending: 1 });
    first.resolve({ state: "confirmed", message: null });
    await flush();
    expect(engine.snapshot()).toMatchObject({ confirmed: 50, pending: 0 });
  });

  it("cancels queued input on an outage instead of sending it on reconnect", async () => {
    const { engine, connection, submit, advance } = await fixture();
    const stalled = deferred<void>();
    submit.mockImplementation(() => stalled.promise);
    for (let index = 0; index < 20; index++) engine.enqueue("increment");
    await flush();
    connection.read.mockRejectedValueOnce(new Error("Node offline"));
    advance(2_000);
    engine.tick();
    await flush();
    expect(engine.snapshot()).toMatchObject({
      ready: false,
      signerBalance: null,
      failed: 4,
      submitted: 16,
    });
    expect(engine.enqueue("decrement")).toBe(false);
    stalled.resolve();
    await flush();
    advance(2_000);
    engine.tick();
    await flush();
    expect(engine.snapshot()).toMatchObject({
      ready: true,
      failed: 4,
      submitted: 16,
    });
  });

  it("allows only one view read at a time and marks an old value as stale", async () => {
    const { engine, connection, advance } = await fixture();
    const read = deferred<Awaited<ReturnType<CounterConnection["read"]>>>();
    connection.read.mockImplementation(() => read.promise);
    advance(3_000);
    engine.tick();
    advance(3_000);
    engine.tick();
    expect(engine.snapshot()).toMatchObject({
      value: 1_000_000n,
      ready: false,
    });
    expect(connection.read).toHaveBeenCalledTimes(2);
    read.resolve({ value: 1_000_025n, signerBalance: 100_000_000n });
    await flush();
    expect(engine.snapshot()).toMatchObject({ value: 1_000_025n, ready: true });
  });

  it("does not submit a prepared transaction after the engine is stopped", async () => {
    const { engine, connection, submit } = await fixture();
    const signing = deferred<{ hash: string; submit: typeof submit }>();
    connection.prepare.mockImplementation(() => signing.promise);
    engine.enqueue("increment");
    engine.stop();
    signing.resolve({ hash: "hash-1", submit });
    await flush();
    expect(submit).not.toHaveBeenCalled();
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });
});
