export interface PollCommit {
  (commit: () => void): void;
}

export interface Poller {
  refresh(): void;
  pause(): void;
  dispose(): void;
}

export function createVisiblePoller(
  intervalMs: number,
  timeoutMs: number,
  task: (signal: AbortSignal, commit: PollCommit) => Promise<void>,
  isVisible: () => boolean = () => document.visibilityState === "visible",
): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let generation = 0;
  let failures = 0;
  let running = false;
  let rerun = false;
  let disposed = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const run = async () => {
    if (disposed || running || !isVisible()) return;
    running = true;
    rerun = false;
    const token = ++generation;
    controller = new AbortController();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const commit: PollCommit = (operation) => {
      if (!disposed && token === generation && isVisible()) operation();
    };
    try {
      await task(signal, commit);
      if (token === generation) failures = 0;
    } catch (cause) {
      if (token === generation && !isAbort(cause)) failures += 1;
    } finally {
      running = false;
      controller = null;
      if (disposed || !isVisible()) return;
      if (rerun || token !== generation) {
        rerun = false;
        queueMicrotask(run);
      } else {
        timer = setTimeout(run, Math.min(60_000, intervalMs * 2 ** failures));
      }
    }
  };
  return {
    refresh() {
      if (disposed) return;
      clearTimer();
      if (running) {
        rerun = true;
        generation += 1;
        controller?.abort(new DOMException("Poll refreshed", "AbortError"));
      } else void run();
    },
    pause() {
      clearTimer();
      rerun = false;
      generation += 1;
      controller?.abort(new DOMException("Polling paused", "AbortError"));
    },
    dispose() {
      disposed = true;
      clearTimer();
      generation += 1;
      controller?.abort(new DOMException("Poller disposed", "AbortError"));
    },
  };
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}
