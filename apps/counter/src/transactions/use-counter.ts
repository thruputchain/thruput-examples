import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../config";
import { initialSnapshot, type Direction, type Snapshot } from "./engine";
import type { WorkerCommand, WorkerEvent } from "./worker";

export function useCounter(config: AppConfig) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (!config.signerAddress) return;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerEvent>) =>
      setSnapshot(event.data.snapshot);
    worker.onerror = () => {
      worker.terminate();
      workerRef.current = null;
      setSnapshot((state) => ({
        ...state,
        ready: false,
        message:
          "The development worker stopped. Reload to start a new session.",
      }));
    };
    worker.postMessage({
      type: "start",
      config,
      rpcUrl: new URL(`${import.meta.env.BASE_URL}thruput-rpc`, location.origin)
        .href,
    } satisfies WorkerCommand);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [config]);

  function send(direction: Direction) {
    workerRef.current?.postMessage({
      type: "input",
      direction,
    } satisfies WorkerCommand);
  }
  return { snapshot, send };
}
