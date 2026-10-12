import { useEffect, useRef, useState } from "react";
import { errorMessage, parseConfig, type AppConfig } from "../config";
import { initialSnapshot, type Direction, type Snapshot } from "./engine";
import type { WorkerCommand, WorkerEvent } from "./worker";

export function useCounter() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | null = null;
    void (async () => {
      const response = await fetch("/api/config", {
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
            errorMessage(body, "Counter configuration could not be loaded."),
        );
      }
      const loaded = parseConfig(body);
      if (controller.signal.aborted) return;
      setConfig(loaded);
      worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerEvent>) =>
        setSnapshot(event.data.snapshot);
      worker.onerror = () => {
        worker?.terminate();
        workerRef.current = null;
        setSnapshot((state) => ({
          ...state,
          ready: false,
          message:
            "The transaction worker stopped. Reload to start a new session.",
        }));
      };
      worker.postMessage({
        type: "start",
        config: loaded,
        rpcUrl: new URL("/thruput-rpc", window.location.origin).href,
      } satisfies WorkerCommand);
    })().catch((error: unknown) => {
      if (!controller.signal.aborted)
        setSnapshot({ ...initialSnapshot, message: errorMessage(error) });
    });
    return () => {
      controller.abort();
      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  function send(direction: Direction) {
    workerRef.current?.postMessage({
      type: "input",
      direction,
    } satisfies WorkerCommand);
  }
  return { config, snapshot, send };
}
