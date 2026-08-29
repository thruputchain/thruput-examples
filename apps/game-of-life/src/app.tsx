import { useEffect, useId, useReducer, useRef, useState } from "react";
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Database,
  Dna,
  Info,
  Radio,
} from "lucide-react";
import type { AppConfig } from "@/config";
import { createReadClient } from "@/chain/client";
import { createLifeReadAdapter } from "@/chain/game-of-life";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { WorldViewport } from "@/components/world-viewport";
import { IndexerClient, type ImmutableSnapshot } from "@/indexer/client";
import { assertSnapshotEligible, SchemaError } from "@/indexer/schema";
import { createVisiblePoller, type Poller } from "@/polling";
import {
  INITIAL_SYNCHRONIZATION_STATE,
  isStatusStale,
  synchronizationReducer,
  type RendererAvailability,
  type SynchronizationAction,
  type SynchronizationState,
} from "@/synchronization";

const REQUEST_TIMEOUT = 8_000;
export function App({ config }: { readonly config: Readonly<AppConfig> }) {
  const [state, dispatch] = useReducer(
    synchronizationReducer,
    INITIAL_SYNCHRONIZATION_STATE,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const [announcement, setAnnouncement] = useState("");
  const [rendererAvailability, setRendererAvailability] =
    useState<RendererAvailability>("initializing");
  const rendererAvailabilityRef = useRef(rendererAvailability);
  const ownedRendererKey = useRef<string | null>(null);
  const [statusClock, setStatusClock] = useState(Date.now());
  const lastAnnouncement = useRef("");
  const [indexer] = useState(() => new IndexerClient(config));
  const [chain] = useState(() =>
    createLifeReadAdapter({
      client: createReadClient(config),
      contractAddress: config.contractAddress,
    }),
  );

  const send = (action: SynchronizationAction) => {
    stateRef.current = synchronizationReducer(stateRef.current, action);
    dispatch(action);
  };
  const updateRendererAvailability = (value: RendererAvailability) => {
    rendererAvailabilityRef.current = value;
    setRendererAvailability(value);
  };

  const announce = (value: string) => {
    if (lastAnnouncement.current === value) return;
    lastAnnouncement.current = value;
    setAnnouncement(value);
  };

  useEffect(() => {
    const pollers: Poller[] = [];
    pollers.push(
      createVisiblePoller(15_000, REQUEST_TIMEOUT, async (signal, commit) => {
        try {
          const result = await raceAbort(chain.metadata(), signal);
          commit(() => send({ type: "chain-read", value: result.value }));
        } catch (cause) {
          commit(() => send({ type: "chain-failed", error: message(cause) }));
          throw cause;
        }
      }),
      createVisiblePoller(5_000, REQUEST_TIMEOUT, async (signal, commit) => {
        try {
          const pointer = await indexer.latest(signal);
          const known = [
            stateRef.current.visualized,
            stateRef.current.candidate,
            stateRef.current.pendingSnapshot,
          ].filter((value): value is ImmutableSnapshot => value !== null);
          const newest = known.sort((left, right) =>
            Number(
              BigInt(right.manifest.generation) -
                BigInt(left.manifest.generation),
            ),
          )[0];
          if (newest) {
            const order =
              BigInt(pointer.generation) - BigInt(newest.manifest.generation);
            if (order < 0n) {
              commit(() => send({ type: "artifact-unchanged" }));
              return;
            }
            if (order === 0n) {
              if (pointer.stateDigest === newest.manifest.stateDigest)
                commit(() => send({ type: "artifact-unchanged" }));
              else
                commit(() =>
                  send({
                    type: "candidate-invalid",
                    error:
                      "Indexer returned conflicting digests for one generation",
                  }),
                );
              return;
            }
          }
          commit(() => send({ type: "artifact-loading" }));
          const snapshot = await indexer.snapshotFromPointer(pointer, signal);
          commit(() => send({ type: "artifact-parsed", snapshot }));
        } catch (cause) {
          commit(() =>
            send({
              type: "artifact-failed",
              condition: artifactFailure(cause),
              error: message(cause),
            }),
          );
          throw cause;
        }
      }),
      createVisiblePoller(5_000, REQUEST_TIMEOUT, async (signal, commit) => {
        try {
          const value = await indexer.status(signal);
          commit(() => send({ type: "status-read", value }));
        } catch (cause) {
          commit(() =>
            send({
              type: "status-failed",
              condition:
                cause instanceof SchemaError ? "malformed" : "unavailable",
              error: message(cause),
            }),
          );
          throw cause;
        }
      }),
    );

    const refresh = () => {
      if (document.visibilityState === "visible")
        for (const poller of pollers) poller.refresh();
      else for (const poller of pollers) poller.pause();
    };
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      for (const poller of pollers) poller.dispose();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [chain, config, indexer]);

  useEffect(() => {
    const snapshot = state.pendingSnapshot;
    if (!snapshot || !state.chain) return;
    if (state.chainVerification === "integrity") {
      send({
        type: "candidate-invalid",
        error: "Chain metadata integrity failure",
      });
      return;
    }
    try {
      assertSnapshotEligible(
        snapshot.manifest,
        snapshot.provenance,
        state.chain,
        config,
      );
      send({ type: "candidate-ready", snapshot });
    } catch (cause) {
      send({ type: "candidate-invalid", error: message(cause) });
    }
  }, [config, state.chain, state.chainVerification, state.pendingSnapshot]);

  useEffect(() => {
    const candidate = state.candidate;
    if (!candidate || !state.chain) return;
    try {
      assertSnapshotEligible(
        candidate.manifest,
        candidate.provenance,
        state.chain,
        config,
      );
    } catch (cause) {
      send({ type: "candidate-invalid", error: message(cause) });
    }
  }, [config, state.candidate, state.chain, state.chainVerification]);

  useEffect(() => {
    setStatusClock(Date.now());
    if (!state.status) return;
    const remaining =
      Date.parse(state.status.heartbeatAt) + 15_000 - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setStatusClock(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [state.status, state.statusEndpoint]);

  useEffect(() => {
    const generation = state.visualized?.manifest.generation;
    if (rendererAvailability === "available" && generation)
      announce(`Ready. Visualized generation ${generation}.`);
    else if (rendererAvailability === "context-lost")
      announce("WebGL context lost. Visualization is unavailable.");
    else if (rendererAvailability === "unavailable")
      announce("Visualization unavailable.");
  }, [rendererAvailability, state.visualized]);

  const visualized = state.visualized;
  const rendererSnapshot = visualized ?? state.candidate;
  if (!visualized) ownedRendererKey.current = null;
  const rendererKey = visualized
    ? (ownedRendererKey.current ??= visualized.manifest.stateDigest)
    : rendererSnapshot?.manifest.stateDigest;
  const initialIdentity =
    !visualized && state.candidate && state.candidateEpoch !== null
      ? {
          epoch: state.candidateEpoch,
          digest: state.candidate.manifest.stateDigest,
        }
      : null;
  const approveCommit = (
    snapshot: ImmutableSnapshot,
    identity: { readonly epoch: number; readonly digest: string },
  ): boolean => {
    const current = stateRef.current;
    if (
      rendererAvailabilityRef.current !== "available" ||
      current.candidateEpoch !== identity.epoch ||
      current.candidate?.manifest.stateDigest !== identity.digest ||
      current.chainVerification === "integrity" ||
      !current.chain
    )
      return false;
    try {
      assertSnapshotEligible(
        snapshot.manifest,
        snapshot.provenance,
        current.chain,
        config,
      );
    } catch (cause) {
      send({ type: "candidate-invalid", error: message(cause) });
      return false;
    }
    send({
      type: "visualization-committed",
      digest: identity.digest,
      epoch: identity.epoch,
    });
    return (
      stateRef.current.visualized?.manifest.stateDigest === identity.digest
    );
  };
  void statusClock;
  return (
    <main className="flex min-h-dvh min-w-80 flex-col overflow-hidden bg-background text-foreground">
      <TopBar state={state} rendererAvailability={rendererAvailability} />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {rendererSnapshot ? (
            <WorldViewport
              key={rendererKey}
              client={indexer}
              initialSnapshot={rendererSnapshot}
              initialIdentity={initialIdentity}
              candidate={visualized ? state.candidate : null}
              candidateEpoch={visualized ? state.candidateEpoch : null}
              onTransition={(value) => {
                send({ type: "transition", value });
              }}
              approveCommit={approveCommit}
              onAnnouncement={announce}
              onAvailability={updateRendererAvailability}
            />
          ) : (
            <EmptyWorld state={state} />
          )}
          <GenerationReadout
            state={state}
            rendererAvailability={rendererAvailability}
          />
          <MobileSheets
            state={state}
            config={config}
            rendererAvailability={rendererAvailability}
          />
        </div>
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border bg-panel/95 lg:block">
          <ActivityContent
            state={state}
            rendererAvailability={rendererAvailability}
          />
          <div className="border-t border-border">
            <DetailsContent state={state} config={config} />
          </div>
        </aside>
      </div>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
    </main>
  );
}

function TopBar({
  state,
  rendererAvailability,
}: {
  readonly state: SynchronizationState;
  readonly rendererAvailability: RendererAvailability;
}) {
  const identity = state.visualized?.manifest;
  return (
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-panel/95 pt-[max(.5rem,var(--safe-top))] pr-[max(.75rem,var(--safe-right))] pb-2 pl-[max(.75rem,var(--safe-left))] sm:pr-[max(1rem,var(--safe-right))] sm:pl-[max(1rem,var(--safe-left))] lg:grid-cols-[minmax(0,1fr)_auto_auto]">
      <div className="flex min-w-0 items-center gap-2.5">
        <a
          href="/"
          aria-label="Homepage"
          className="grid size-12 shrink-0 place-items-center rounded-md border border-primary/35 bg-primary/10 text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9 [@media(pointer:coarse)]:size-12"
        >
          <Dna />
        </a>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Life Observatory</h1>
          <p className="truncate font-mono text-xs text-muted-foreground sm:text-sm">
            100,000,000 cells · Conway B3/S23
          </p>
        </div>
      </div>
      <div className="hidden items-center gap-6 lg:flex">
        <Metric label="On-chain" value={state.chain?.generation ?? "—"} />
        <Metric
          label="Visualized"
          value={
            !identity
              ? "—"
              : rendererAvailability === "available"
                ? identity.generation
                : "Unavailable"
          }
          warning={isBehind(state) || state.chainVerification === "integrity"}
        />
        <Metric
          label="Population"
          value={identity ? Number(identity.population).toLocaleString() : "—"}
        />
        <Metric
          label="Digest"
          value={identity ? abbreviate(identity.stateDigest) : "—"}
          mono
        />
      </div>
      <IndexerHealth state={state} />
    </header>
  );
}

export function GenerationReadout({
  state,
  rendererAvailability = "available",
}: {
  readonly state: SynchronizationState;
  readonly rendererAvailability?: RendererAvailability;
}) {
  const visualized = state.visualized?.manifest.generation;
  return (
    <div className="pointer-events-none absolute top-[max(.75rem,var(--safe-top))] right-[calc(max(.75rem,var(--safe-right))+7rem)] left-[max(.75rem,var(--safe-left))] flex items-center gap-2 rounded-md border border-border bg-panel/95 px-3 py-2 font-mono text-xs shadow-sm backdrop-blur-md sm:right-auto sm:max-w-[calc(100%-2rem)] sm:text-sm">
      {isBehind(state) || state.chainVerification === "integrity" ? (
        <CircleAlert className="shrink-0 text-warning" />
      ) : (
        <CircleCheck className="shrink-0 text-primary" />
      )}
      <span className="truncate">
        {!state.visualized
          ? "No ready visualization"
          : rendererAvailability !== "available"
            ? "Visualization unavailable"
            : state.transition !== "idle"
              ? `Preparing visualization ${state.candidate?.manifest.generation ?? ""}`
              : state.chainVerification === "integrity"
                ? `Chain integrity warning · retained generation ${visualized ?? "—"}`
                : isBehind(state)
                  ? `Displaying older generation ${visualized ?? "—"}`
                  : `Ready · generation ${visualized}`}
      </span>
    </div>
  );
}

function MobileSheets({
  state,
  config,
  rendererAvailability,
}: {
  readonly state: SynchronizationState;
  readonly config: Readonly<AppConfig>;
  readonly rendererAvailability: RendererAvailability;
}) {
  return (
    <div className="absolute top-[max(.75rem,var(--safe-top))] right-[max(.75rem,var(--safe-right))] flex gap-2 lg:hidden">
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-12 bg-panel/95"
            aria-label="Open activity"
          >
            <Activity />
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Generation activity</SheetTitle>
            <SheetDescription>
              Independent chain, indexer preparation, and visualization state.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto">
            <ActivityContent
              state={state}
              rendererAvailability={rendererAvailability}
            />
          </div>
        </SheetContent>
      </Sheet>
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-12 bg-panel/95"
            aria-label="Open world details"
          >
            <Info />
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>World details</SheetTitle>
            <SheetDescription>
              Snapshot identity, scope, and verification boundary.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto">
            <DetailsContent state={state} config={config} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function ActivityContent({
  state,
  rendererAvailability = "available",
}: {
  readonly state: SynchronizationState;
  readonly rendererAvailability?: RendererAvailability;
}) {
  const title = useId();
  const status = state.status;
  const stale = state.statusEndpoint === "fresh" && isStatusStale(status);
  const freshStatus =
    state.statusEndpoint === "fresh" && !stale ? status : null;
  return (
    <section className="flex flex-col gap-4 p-4" aria-labelledby={title}>
      <div>
        <p
          id={title}
          className="text-xs font-medium tracking-widest text-muted-foreground uppercase"
        >
          Activity
        </p>
        <h2 className="mt-1 text-lg font-medium">Generation pipeline</h2>
      </div>
      <PipelineRow
        icon={Radio}
        label="On-chain"
        value={
          state.chain ? `Generation ${state.chain.generation}` : "Unavailable"
        }
        detail={state.chainError ?? "Authoritative contract metadata"}
      />
      <PipelineRow
        icon={Database}
        label="Preparing visualization"
        value={
          freshStatus?.preparing
            ? `Generation ${freshStatus.preparing.generation}`
            : state.candidate
              ? `Generation ${state.candidate.manifest.generation}`
              : "No pending generation"
        }
        detail={preparationDetail(state)}
      />
      <PipelineRow
        icon={CircleCheck}
        label="Visualization"
        value={
          rendererAvailability === "unavailable" ||
          rendererAvailability === "context-lost"
            ? "Unavailable"
            : state.visualized
              ? `Generation ${state.visualized.manifest.generation}`
              : "No active visualization"
        }
        detail={
          rendererAvailability === "context-lost"
            ? "WebGL context lost; verified metadata retained"
            : rendererAvailability === "unavailable"
              ? "Renderer unavailable; verified metadata retained"
              : !state.visualized && state.candidate
                ? "Verified snapshot is loading renderer coverage"
                : state.chainVerification === "integrity"
                  ? "Retained during chain identity conflict"
                  : isBehind(state)
                    ? "Displaying older generation"
                    : state.visualized
                      ? "Actively displayed"
                      : "Nothing has renderer ownership"
        }
      />
      <div className="rounded-md border border-border bg-background/45 p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">
          {statusHealthLabel(state)}
        </p>
        {freshStatus?.preparing ? (
          <p className="mt-1">
            {freshStatus.preparing.completedUnits.toLocaleString()} /{" "}
            {freshStatus.preparing.totalUnits.toLocaleString()}{" "}
            {freshStatus.preparing.unit}
          </p>
        ) : null}
        {freshStatus?.errorCode ? (
          <p className="mt-1">Error {freshStatus.errorCode}</p>
        ) : null}
        {freshStatus?.retry ? (
          <p className="mt-1">
            Retry {freshStatus.retry.attempt} at{" "}
            {formatDate(freshStatus.retry.nextAt)}
          </p>
        ) : null}
        {stale ? (
          <p className="mt-1">Last-reported status heartbeat is stale.</p>
        ) : null}
        {state.statusError ? <p className="mt-1">{state.statusError}</p> : null}
      </div>
    </section>
  );
}

export function DetailsContent({
  state,
  config,
}: {
  readonly state: SynchronizationState;
  readonly config: Readonly<AppConfig>;
}) {
  const title = useId();
  const snapshot = state.visualized ?? state.candidate;
  const manifest = snapshot?.manifest;
  const provenance = snapshot?.provenance;
  return (
    <section className="flex flex-col gap-4 p-4" aria-labelledby={title}>
      <div>
        <p
          id={title}
          className="text-xs font-medium tracking-widest text-muted-foreground uppercase"
        >
          World details
        </p>
        <h2 className="mt-1 text-lg font-medium">
          {state.visualized
            ? "Immutable snapshot"
            : state.candidate
              ? "Verified snapshot metadata"
              : "Snapshot metadata"}
        </h2>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <Detail label="Generation" value={manifest?.generation} />
        <Detail label="Population" value={manifest?.population} />
        <Detail
          label="Dimensions"
          value={
            manifest ? `${manifest.width} × ${manifest.height}` : undefined
          }
        />
        <Detail label="Seed" value={manifest?.seed} />
        <Detail label="Digest" value={manifest?.stateDigest} mono />
        <Detail
          label="Contract"
          value={manifest?.contractAddress ?? config.contractAddress}
          mono
        />
        <Detail label="Source block" value={provenance?.sourceBlockHeight} />
        <Detail label="Block hash" value={provenance?.sourceBlockHash} mono />
        <Detail label="Provenance" value={provenance?.evidenceKind} />
      </dl>
      <div className="flex flex-col gap-2 rounded-md border border-border bg-background/45 p-3 text-base text-muted-foreground lg:text-sm">
        <p>
          One Groundhog contract invocation reads, computes, and commits the
          exact next state of a persistent 100-million-cell Conway world
          atomically.
        </p>
        <p>The indexer derives visualization artifacts from committed state.</p>
        <p>
          Snapshot verified by indexer against the complete on-chain digest;
          individual tiles do not carry proofs.
        </p>
      </div>
    </section>
  );
}

function EmptyWorld({ state }: { readonly state: SynchronizationState }) {
  return (
    <section className="grid min-h-0 flex-1 place-items-center bg-canvas p-6">
      <div className="max-w-[52ch] text-center">
        <h2 className="text-xl font-semibold">No ready visualization</h2>
        <p className="mt-2 text-muted-foreground">
          {emptyVisualizationMessage(state)}
        </p>
        {state.chain ? (
          <p className="mt-4 font-mono text-sm">
            On-chain generation {state.chain.generation} · population{" "}
            {Number(state.chain.population).toLocaleString()}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PipelineRow({
  icon: Icon,
  label,
  value,
  detail,
}: {
  readonly icon: typeof Activity;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2">
      <Icon className="mt-0.5 text-primary" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium">{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function IndexerHealth({ state }: { readonly state: SynchronizationState }) {
  const healthy =
    state.statusEndpoint === "fresh" && !isStatusStale(state.status);
  return (
    <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground sm:text-sm">
      {!healthy ? (
        <CircleAlert className="text-warning" />
      ) : (
        <Activity className="text-primary" />
      )}
      <span>
        {healthy ? `Indexer ${state.status?.state}` : statusHealthLabel(state)}
      </span>
    </div>
  );
}

function Metric({
  label,
  value,
  mono = false,
  warning = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly warning?: boolean;
}) {
  return (
    <dl className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-sm",
          mono ? "font-mono" : "font-medium",
          warning && "text-warning",
        )}
      >
        {value}
      </dd>
    </dl>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`${mono ? "break-all font-mono text-xs" : ""} min-w-0 text-right`}
      >
        {value ?? "—"}
      </dd>
    </>
  );
}

function preparationDetail(state: SynchronizationState): string {
  if (state.artifactError) return state.artifactError;
  if (state.artifactState === "awaiting-chain")
    return "Artifacts loaded; awaiting chain verification";
  if (state.artifactState === "unavailable")
    return "Visualization updates unavailable";
  if (state.artifactState === "malformed") return "Indexer artifacts malformed";
  if (state.transition === "crossfading") return "Visible coverage ready";
  if (state.transition === "staging")
    return "Loading required visible coverage";
  return "Static artifacts are polled independently";
}

function statusHealthLabel(state: SynchronizationState): string {
  if (state.statusEndpoint === "malformed") return "Indexer status malformed";
  if (state.statusEndpoint === "unavailable")
    return "Indexer status unavailable";
  if (isStatusStale(state.status)) return "Indexer status stale";
  return `Indexer ${state.status?.state ?? "unavailable"}`;
}

function emptyVisualizationMessage(state: SynchronizationState): string {
  if (state.artifactState === "awaiting-chain")
    return "Snapshot artifacts loaded; awaiting chain verification.";
  if (state.artifactState === "unavailable")
    return "Visualization updates unavailable and no verified snapshot is available.";
  if (state.artifactState === "malformed")
    return "Indexer artifacts are malformed; no snapshot can be displayed.";
  if (state.artifactState === "invalid")
    return (
      state.artifactError ?? "Snapshot evidence is not eligible for display."
    );
  return "Validating immutable indexer artifacts.";
}

function isBehind(state: SynchronizationState): boolean {
  return Boolean(
    state.chain &&
    state.visualized &&
    BigInt(state.chain.generation) >
      BigInt(state.visualized.manifest.generation),
  );
}

function abbreviate(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Request failed";
}

function artifactFailure(cause: unknown): "unavailable" | "malformed" {
  return cause instanceof SchemaError ||
    (cause instanceof Error &&
      /content type|content length|disagree|scope|escaped|schema/i.test(
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
