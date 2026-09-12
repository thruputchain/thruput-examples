import type { AppConfig } from "../config";
import { errorMessage } from "../config";
import { createCounterConnection } from "../groundhog/client";
import {
  initialSnapshot,
  TransactionEngine,
  type Direction,
  type Snapshot,
} from "./engine";

export type WorkerCommand =
  | { type: "start"; config: AppConfig; rpcUrl: string }
  | { type: "input"; direction: Direction };
export type WorkerEvent = { type: "snapshot"; snapshot: Snapshot };

let engine: TransactionEngine | null = null;
let starting = false;
let startupError: string | null = null;
let startup: Extract<WorkerCommand, { type: "start" }> | null = null;
let nextAttempt = 0;
let nextPublish = 0;
function publish(snapshot: Snapshot) {
  postMessage({ type: "snapshot", snapshot } satisfies WorkerEvent);
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  if (command.type === "input") {
    engine?.enqueue(command.direction);
    nextPublish = 0;
  } else if (!startup) {
    startup = command;
  }
};

function connect() {
  if (!startup || starting || engine || Date.now() < nextAttempt) return;
  starting = true;
  void createCounterConnection(startup.config, startup.rpcUrl)
    .then((connection) => {
      engine = new TransactionEngine(connection);
    })
    .catch((error: unknown) => {
      startupError = errorMessage(error);
    })
    .finally(() => {
      starting = false;
      nextAttempt = Date.now() + 2_000;
    });
}

// Rendering sees at most 20 snapshots per second, even under a large input burst.
setInterval(() => {
  connect();
  engine?.tick();
  if (Date.now() < nextPublish) return;
  const snapshot = engine?.snapshot() ?? {
    ...initialSnapshot,
    message: startupError ?? initialSnapshot.message,
  };
  publish(snapshot);
  nextPublish =
    Date.now() + (snapshot.pending + snapshot.unknown > 0 ? 50 : 500);
}, 50);
