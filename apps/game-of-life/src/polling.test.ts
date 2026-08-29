import { afterEach, describe, expect, test, vi } from "vitest";
import { createVisiblePoller } from "./polling";

afterEach(() => vi.useRealTimers());

describe("visible poller", () => {
  test("allows a genuine timeout failure to commit", async () => {
    const commits: string[] = [];
    const poller = createVisiblePoller(
      5_000,
      10,
      async (signal, commit) => {
        try {
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        } catch {
          commit(() => commits.push("timeout"));
        }
      },
      () => true,
    );
    poller.refresh();
    await vi.waitFor(() => expect(commits).toEqual(["timeout"]));
    poller.dispose();
  });

  test("invalidates hidden completion and reruns immediately on refresh", async () => {
    vi.useFakeTimers();
    let visible = true;
    let finish!: () => void;
    const commits: number[] = [];
    let runs = 0;
    const poller = createVisiblePoller(
      5_000,
      8_000,
      async (_signal, commit) => {
        const run = ++runs;
        await new Promise<void>((resolve) => (finish = resolve));
        commit(() => commits.push(run));
      },
      () => visible,
    );
    poller.refresh();
    await vi.waitFor(() => expect(runs).toBe(1));
    visible = false;
    poller.pause();
    finish();
    await Promise.resolve();
    expect(commits).toEqual([]);
    visible = true;
    poller.refresh();
    await vi.waitFor(() => expect(runs).toBe(2));
    finish();
    await Promise.resolve();
    expect(commits).toEqual([2]);
    poller.dispose();
  });

  test("refresh during a run aborts it and schedules an immediate rerun", async () => {
    let runs = 0;
    const signals: AbortSignal[] = [];
    const poller = createVisiblePoller(
      5_000,
      8_000,
      async (signal) => {
        runs += 1;
        signals.push(signal);
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      () => true,
    );
    poller.refresh();
    await vi.waitFor(() => expect(runs).toBe(1));
    poller.refresh();
    await vi.waitFor(() => expect(runs).toBe(2));
    expect(signals[0]?.aborted).toBe(true);
    poller.dispose();
  });

  test("restoration runs immediately instead of waiting for the interval", async () => {
    let visible = false;
    let runs = 0;
    const poller = createVisiblePoller(
      60_000,
      8_000,
      async () => {
        runs += 1;
      },
      () => visible,
    );
    poller.refresh();
    expect(runs).toBe(0);
    visible = true;
    poller.refresh();
    await vi.waitFor(() => expect(runs).toBe(1));
    poller.dispose();
  });
});
