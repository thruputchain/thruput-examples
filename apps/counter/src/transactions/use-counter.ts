import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../config";
import { initialSnapshot, type Direction, type Snapshot } from "./engine";
import type { WorkerCommand, WorkerEvent } from "./worker";

export function useCounter(config: AppConfig, accepting: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const workerRef = useRef<Worker | null>(null);
  const acceptingRef = useRef(accepting);
  acceptingRef.current = accepting;

  useEffect(() => {
    if (!config.signerAddress) return;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => setSnapshot(event.data.snapshot);
    worker.onerror = () => {
      worker.terminate();
      workerRef.current = null;
      setSnapshot(state => ({ ...state, ready: false, message: "The development worker stopped. Reload to start a new session." }));
    };
    worker.postMessage({ type: "start", config, rpcUrl: new URL("/groundhog-rpc", location.origin).href, accepting: acceptingRef.current } satisfies WorkerCommand);
    return () => { worker.terminate(); workerRef.current = null; };
  }, [config]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "accepting", value: accepting } satisfies WorkerCommand);
  }, [accepting]);

  function send(direction: Direction) {
    if (acceptingRef.current) workerRef.current?.postMessage({ type: "input", direction } satisfies WorkerCommand);
  }
  return { snapshot, send };
}
