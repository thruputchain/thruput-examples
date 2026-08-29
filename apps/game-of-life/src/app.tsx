import { startTransition, useEffect, useState } from "react";
import { Activity, Database, Dna } from "lucide-react";
import type { AppConfig } from "@/config";
import { createReadClient } from "@/chain/client";
import {
  createLifeReadAdapter,
  type ChainMetadata,
} from "@/chain/game-of-life";
import {
  markChainReadFailed,
  reconcileChainMetadata,
  type ChainVerification,
} from "@/chain/metadata-state";
import { WorldViewport } from "@/components/world-viewport";
import { IndexerClient, type ImmutableSnapshot } from "@/indexer/client";
import { assertSnapshotEligible, type LifeStatus } from "@/indexer/schema";

interface State {
  readonly snapshot: ImmutableSnapshot | null;
  readonly chain: ChainMetadata | null;
  readonly status: LifeStatus | null;
  readonly snapshotError: string | null;
  readonly chainError: string | null;
  readonly chainVerification: ChainVerification;
}
const INITIAL: State = {
  snapshot: null,
  chain: null,
  status: null,
  snapshotError: null,
  chainError: null,
  chainVerification: "loading",
};

export function App({ config }: { readonly config: Readonly<AppConfig> }) {
  const [state, setState] = useState(INITIAL);
  const [indexer] = useState(() => new IndexerClient(config));
  const [chain] = useState(() =>
    createLifeReadAdapter({
      client: createReadClient(config),
      contractAddress: config.contractAddress,
    }),
  );
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(8_000),
    ]);
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const commit = (patch: Partial<State>) => {
      if (controller.signal.aborted) return;
      startTransition(() => setState((current) => ({ ...current, ...patch })));
    };
    void indexer.snapshot(signal).then(
      (snapshot) => commit({ snapshot, snapshotError: null }),
      (cause) => commit({ snapshot: null, snapshotError: message(cause) }),
    );
    void indexer.status(signal).then(
      (status) => commit({ status }),
      () => commit({ status: null }),
    );

    const schedulePoll = () => {
      if (!controller.signal.aborted && document.visibilityState === "visible")
        pollTimer = setTimeout(pollMetadata, 15_000);
    };
    const pollMetadata = async () => {
      if (
        polling ||
        controller.signal.aborted ||
        document.visibilityState !== "visible"
      )
        return;
      polling = true;
      try {
        const result = await withTimeout(chain.metadata(), 8_000);
        if (controller.signal.aborted) return;
        startTransition(() =>
          setState((current) => reconcileChainMetadata(current, result.value)),
        );
      } catch (cause) {
        if (!controller.signal.aborted)
          startTransition(() =>
            setState((current) => markChainReadFailed(current, message(cause))),
          );
      } finally {
        polling = false;
        schedulePoll();
      }
    };
    const onVisibility = () => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
      if (document.visibilityState === "visible") void pollMetadata();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void pollMetadata();
    return () => {
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [chain, indexer]);

  let snapshot = state.snapshot;
  let snapshotError = state.snapshotError;
  if (snapshot && state.chainVerification === "integrity") {
    snapshot = null;
    snapshotError = state.chainError;
  } else if (snapshot && state.chain) {
    try {
      assertSnapshotEligible(
        snapshot.manifest,
        snapshot.provenance,
        state.chain,
        config,
      );
    } catch (cause) {
      snapshot = null;
      snapshotError = message(cause);
    }
  } else if (snapshot) {
    snapshot = null;
    snapshotError = state.chainError
      ? `Current chain metadata could not validate this snapshot: ${state.chainError}`
      : "Validating snapshot against current chain metadata…";
  }

  const identity = snapshot?.manifest;
  return (
    <main className="flex h-dvh min-h-[420px] min-w-80 flex-col overflow-hidden bg-background text-foreground">
      <header className="grid shrink-0 grid-cols-[1fr_auto] items-center gap-3 border-b border-border bg-panel px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <a
            href="/"
            aria-label="Homepage"
            className="grid size-8 shrink-0 place-items-center rounded-md border border-primary/35 bg-primary/10 text-primary"
          >
            <Dna />
          </a>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">
              Life Observatory
            </h1>
            <p className="truncate font-mono text-sm text-muted-foreground">
              100,000,000 cells · Conway B3/S23
            </p>
          </div>
        </div>
        <div className="hidden items-center gap-5 sm:flex">
          <Metric
            label="Generation"
            value={identity?.generation ?? state.chain?.generation ?? "—"}
          />
          <Metric
            label="Population"
            value={
              identity
                ? Number(identity.population).toLocaleString()
                : state.chain
                  ? Number(state.chain.population).toLocaleString()
                  : "—"
            }
          />
          <Metric
            label="Digest"
            value={identity ? `${identity.stateDigest.slice(0, 10)}…` : "—"}
            mono
          />
        </div>
        <div className="flex items-center gap-1.5 font-mono text-sm text-muted-foreground">
          <Activity />
          <span>{state.status?.state ?? "offline"}</span>
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-panel/80 px-3 py-1.5 text-sm text-muted-foreground sm:px-4">
        <Database className="shrink-0" />
        <span className="min-w-0 truncate">
          {identity
            ? `Immutable generation ${identity.generation} · ${identity.width} × ${identity.height} · source block ${snapshot?.provenance.sourceBlockHeight}`
            : (snapshotError ?? "Loading immutable snapshot…")}
        </span>
        {state.chainVerification !== "fresh" ? (
          <span
            role="status"
            aria-live="polite"
            className="ml-auto shrink-0 text-warning"
          >
            {chainVerificationLabel(state.chainVerification)}
          </span>
        ) : null}
      </div>
      {snapshot ? (
        <WorldViewport client={indexer} snapshot={snapshot} />
      ) : (
        <section className="grid min-h-0 flex-1 place-items-center p-6">
          <div className="max-w-[52ch] text-center">
            <h2 className="text-balance text-xl font-semibold">
              No ready visualization
            </h2>
            <p className="mt-2 text-pretty text-base text-muted-foreground sm:text-sm">
              {snapshotError ?? "Validating the latest immutable artifacts."}
            </p>
            {state.chain ? (
              <p className="mt-4 font-mono text-sm">
                On-chain generation {state.chain.generation} · population{" "}
                {Number(state.chain.population).toLocaleString()}
              </p>
            ) : null}
          </div>
        </section>
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <dl className="min-w-0">
      <dt className="truncate text-sm text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-sm" : "text-sm font-medium"}>
        {value}
      </dd>
    </dl>
  );
}
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Request failed";
}

function chainVerificationLabel(value: ChainVerification): string {
  if (value === "stale") return "Chain metadata stale";
  if (value === "integrity") return "Chain metadata integrity failure";
  if (value === "unavailable") return "Chain metadata unavailable";
  return "Validating chain";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chain read timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
