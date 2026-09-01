import { useEffect, useReducer, useRef, useState } from "react";
import { createLifeReadAdapter } from "@/chain/game-of-life";
import {
  createReadOnlyClient,
  MalformedRpcResponseError,
} from "@/chain/read-only-client";
import type { ReadAppConfig } from "@/config";
import { IndexerClient } from "@/indexer/client";
import { SchemaError } from "@/indexer/schema";
import { createVisiblePoller, type Poller } from "@/polling";
import {
  INITIAL_EVIDENCE_STATE,
  evidenceReducer,
  message,
  reconcileEvidence,
  type XrayEvidenceState,
} from "./evidence";
import { inspectExactCell } from "./exact-cell";

const REQUEST_TIMEOUT = 8_000;

export function useXrayEvidence(config: Readonly<ReadAppConfig>) {
  const [state, dispatch] = useReducer(evidenceReducer, INITIAL_EVIDENCE_STATE);
  const [announcement, setAnnouncement] = useState("");
  const [indexer] = useState(() => new IndexerClient(config));
  const [chain] = useState(() =>
    createLifeReadAdapter({
      client: createReadOnlyClient(config),
      contractAddress: config.contractAddress,
    }),
  );
  const [inspectCell] = useState(
    () =>
      (
        snapshot: NonNullable<XrayEvidenceState["snapshot"]["value"]>,
        x: number,
        y: number,
        signal: AbortSignal,
      ) =>
        inspectExactCell(indexer, snapshot, x, y, signal),
  );
  const pollers = useRef<readonly Poller[]>([]);
  const previousAnnouncement = useRef("");
  const relationship = reconcileEvidence(state, config);

  useEffect(() => {
    const activePollers = [
      createVisiblePoller(15_000, REQUEST_TIMEOUT, async (signal, commit) => {
        try {
          const result = await raceAbort(chain.metadata(), signal);
          commit(() => dispatch({ type: "chain-read", value: result.value }));
        } catch (cause) {
          commit(() =>
            dispatch({
              type: "chain-failed",
              condition: chainFailure(cause),
              error: message(cause),
            }),
          );
          throw cause;
        }
      }),
      createVisiblePoller(5_000, REQUEST_TIMEOUT, async (signal, commit) => {
        try {
          const pointer = await indexer.latest(signal);
          const snapshot = await indexer.snapshotFromPointer(pointer, signal);
          commit(() => dispatch({ type: "snapshot-read", value: snapshot }));
        } catch (cause) {
          commit(() =>
            dispatch({
              type: "snapshot-failed",
              condition: artifactFailure(cause),
              error: message(cause),
            }),
          );
          throw cause;
        }
      }),
    ];
    pollers.current = activePollers;
    const refreshForVisibility = () => {
      if (document.visibilityState === "visible")
        for (const poller of activePollers) poller.refresh();
      else for (const poller of activePollers) poller.pause();
    };
    document.addEventListener("visibilitychange", refreshForVisibility);
    refreshForVisibility();
    return () => {
      pollers.current = [];
      for (const poller of activePollers) poller.dispose();
      document.removeEventListener("visibilitychange", refreshForVisibility);
    };
  }, [chain, indexer]);

  useEffect(() => {
    if (state.chain.status === "loading" && state.snapshot.status === "loading")
      return;
    const next = `${relationship.label}. ${relationship.detail}`;
    if (next === previousAnnouncement.current) return;
    previousAnnouncement.current = next;
    setAnnouncement(next);
  }, [
    relationship.detail,
    relationship.label,
    state.chain.status,
    state.snapshot.status,
  ]);

  const retry = () => {
    setAnnouncement("Evidence refresh requested.");
    for (const poller of pollers.current) poller.refresh();
  };

  return { state, relationship, announcement, retry, inspectCell } as const;
}

function artifactFailure(cause: unknown): "unavailable" | "malformed" {
  return cause instanceof SchemaError ||
    cause instanceof SyntaxError ||
    (cause instanceof Error &&
      /content type|content length|disagree|scope|escaped|schema/i.test(
        cause.message,
      ))
    ? "malformed"
    : "unavailable";
}

function chainFailure(cause: unknown): "unavailable" | "malformed" {
  return cause instanceof MalformedRpcResponseError ||
    cause instanceof SyntaxError ||
    (cause instanceof Error &&
      /decode|metadata|return data|schema|unsupported|invalid json-rpc .*response/i.test(
        cause.message,
      ))
    ? "malformed"
    : "unavailable";
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}
