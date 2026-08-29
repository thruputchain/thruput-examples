import { startTransition, useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, RotateCcw, Zap } from "lucide-react";
import type { GroundhogClient } from "@groundhogchain/client";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import { Button } from "@/components/ui/button";
import type { DevelopmentPersona } from "@/development-personas";
import {
  observeCompletions,
  applyCompletionBatch,
} from "@/transactions/observer";
import {
  crankStorageKey,
  isTransactionStorageKey,
  loadCranks,
  loadRequests,
  requestStorageKey,
  saveRequests,
  transactionScope,
  withTransactionLock,
  type CrankRecord,
  type TickRequestRecord,
} from "@/transactions/records";
import { createLocalWriteBoundary } from "@/transactions/write-boundary";
import {
  abandonUnsignedCrank,
  abandonUnsignedRequest,
  processOneTick,
  recoverCrank,
  recoverRequest,
  requestTick,
  type WorkflowResult,
} from "@/transactions/workflow";

export function TransactionActivity({
  config,
  profiles,
  persona,
  client,
  onCrankCommitted,
}: {
  readonly config: Readonly<AppConfig>;
  readonly profiles: LifeTransactionProfiles;
  readonly persona: DevelopmentPersona;
  readonly client: GroundhogClient;
  readonly onCrankCommitted: () => void;
}) {
  const scope = transactionScope(config, persona.expectedCallerHex);
  const [boundary] = useState(() =>
    createLocalWriteBoundary(config, persona, client),
  );
  const [initial] = useState(() => initialRecords(scope));
  const [requests, setRequests] = useState<readonly TickRequestRecord[]>(
    initial.requests,
  );
  const [cranks, setCranks] = useState<readonly CrankRecord[]>(initial.cranks);
  const [mode, setMode] = useState<"automatic" | "manual">("automatic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initial.error);

  const apply = (result: WorkflowResult) => {
    startTransition(() => {
      setRequests(result.requests);
      setCranks(result.cranks);
    });
    if (result.cranks.some(({ status }) => status === "advanced"))
      onCrankCommitted();
  };

  useEffect(() => {
    const reload = () => {
      try {
        setRequests(loadRequests(scope));
        setCranks(loadCranks(scope));
        setError(null);
      } catch (cause) {
        setError(message(cause));
      }
    };
    const storage = (event: StorageEvent) => {
      if (isTransactionStorageKey(scope, event.key)) reload();
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, [crankStorageKey(scope), requestStorageKey(scope)]);

  useEffect(() => {
    let disposed = false;
    let running = false;
    const scan = async () => {
      if (disposed || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const scanned = loadRequests(scope).filter(
          ({ status }) => status === "accepted",
        );
        const batch = await observeCompletions({
          client,
          contractAddress: config.contractAddress,
          requests: scanned,
        });
        if (
          disposed ||
          (batch.observations.length === 0 &&
            batch.observedThroughBlock === null)
        )
          return;
        const next = await withTransactionLock(scope, async () =>
          saveRequests(
            scope,
            applyCompletionBatch(loadRequests(scope), scanned, batch),
          ),
        );
        if (!disposed) startTransition(() => setRequests(next));
        if (batch.observations.length > 0) onCrankCommitted();
      } catch (cause) {
        if (!disposed) setError(message(cause));
      } finally {
        running = false;
      }
    };
    void scan();
    const timer = window.setInterval(scan, 5_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, config.contractAddress, crankStorageKey(scope)]);

  const run = async (action: () => Promise<WorkflowResult>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      apply(await action());
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const common = { config, profiles, persona, boundary };
  const latestRequest = requests.at(-1);
  const latestCrank = cranks.at(-1);
  const recoverableRequests = requests.filter(
    (record) =>
      record.transactionHash !== null &&
      ["signing", "indeterminate", "acceptedUntracked"].includes(record.status),
  );
  const recoverableCranks = cranks.filter(
    (record) =>
      record.transactionHash !== null &&
      ["signing", "indeterminate"].includes(record.status),
  );
  const unsignedRequests = requests.filter(
    (record) => record.status === "signing" && record.transactionHash === null,
  );
  const unsignedCranks = cranks.filter(
    (record) => record.status === "signing" && record.transactionHash === null,
  );

  return (
    <section className="pointer-events-none absolute right-[max(.75rem,var(--safe-right))] bottom-[max(.75rem,var(--safe-bottom))] left-[max(.75rem,var(--safe-left))] z-20 rounded-lg border border-border bg-panel/95 p-3 shadow-lg backdrop-blur-md sm:left-auto sm:w-[23rem] [@media(max-height:400px)]:right-auto [@media(max-height:400px)]:left-[max(.75rem,var(--safe-left))]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Evolution control
          </p>
          <p className="mt-0.5 text-sm">Signed as {persona.label}</p>
        </div>
        <label className="pointer-events-auto flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={mode === "automatic"}
            onChange={(event) =>
              setMode(event.target.checked ? "automatic" : "manual")
            }
            disabled={busy}
          />
          Auto process
        </label>
      </div>
      <Button
        className="pointer-events-auto mt-3 w-full justify-between"
        disabled={busy}
        onClick={() =>
          void run(() =>
            requestTick({ ...common, automaticCrank: mode === "automatic" }),
          )
        }
      >
        <span className="flex items-center gap-2">
          {busy ? <LoaderCircle className="animate-spin" /> : <Zap />}
          Advance 100,000,000 cells
        </span>
        <ChevronRight />
      </Button>
      {mode === "manual" ? (
        <Button
          variant="outline"
          className="pointer-events-auto mt-2 w-full"
          disabled={busy}
          onClick={() => void run(() => processOneTick(common))}
        >
          Process one queued request
        </Button>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Status
          label="Request"
          value={
            latestRequest ? requestLabel(latestRequest) : "No local request"
          }
        />
        <Status
          label="Crank"
          value={latestCrank ? crankLabel(latestCrank) : "No local crank"}
        />
      </div>
      {recoverableRequests.map((record) => (
        <RecoveryButton
          key={record.localId}
          label={`Check request ${abbreviate(record.transactionHash!)}`}
          busy={busy}
          onClick={() =>
            run(() => recoverRequest({ ...common, localId: record.localId }))
          }
        />
      ))}
      {recoverableCranks.map((record) => (
        <RecoveryButton
          key={record.localId}
          label={`Check crank ${abbreviate(record.transactionHash!)}`}
          busy={busy}
          onClick={() =>
            run(() => recoverCrank({ ...common, localId: record.localId }))
          }
        />
      ))}
      {unsignedRequests.map((record) => (
        <RecoveryButton
          key={record.localId}
          label="I confirm signing did not complete"
          busy={busy}
          onClick={() =>
            run(() =>
              abandonUnsignedRequest({
                config,
                persona,
                localId: record.localId,
              }),
            )
          }
        />
      ))}
      {unsignedCranks.map((record) => (
        <RecoveryButton
          key={record.localId}
          label="I confirm crank signing did not complete"
          busy={busy}
          onClick={() =>
            run(() =>
              abandonUnsignedCrank({
                config,
                persona,
                localId: record.localId,
              }),
            )
          }
        />
      ))}
      {requests.length > 0 || cranks.length > 0 ? (
        <details className="pointer-events-auto mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer text-foreground">
            Inspect durable history
          </summary>
          <ol className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono">
            {[...requests].reverse().map((record) => (
              <li key={record.localId} className="break-all">
                Request {record.status} · {record.receiptBlock ?? "no receipt"}{" "}
                · {record.transactionHash ?? "no hash"}
                {record.diagnostic ? ` · ${record.diagnostic}` : ""}
              </li>
            ))}
            {[...cranks].reverse().map((record) => (
              <li key={record.localId} className="break-all">
                Crank {record.status} · {record.receiptBlock ?? "no receipt"} ·{" "}
                {record.transactionHash ?? "no hash"}
                {record.diagnostic ? ` · ${record.diagnostic}` : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Request and processing are separate durable transactions. Local event
        tracking is finite; missing retained history is reported as permanently
        unknown.
      </p>
    </section>
  );
}

function RecoveryButton({
  label,
  busy,
  onClick,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly onClick: () => Promise<void>;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void onClick()}
      className="pointer-events-auto mt-2 flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline disabled:opacity-50"
    >
      <RotateCcw className="size-3" /> {label}
    </button>
  );
}

function Status({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background/45 p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-foreground">{value}</p>
    </div>
  );
}

function requestLabel(record: TickRequestRecord): string {
  if (record.status === "completionUnknown") return "Completion unknown";
  if (record.status === "advanced")
    return `Advanced to ${record.resultingGeneration}`;
  return record.status;
}

function crankLabel(record: CrankRecord): string {
  if (record.status === "advanced")
    return `Advanced to ${record.resultingGeneration}`;
  return record.status === "noWork" ? "Found no work" : record.status;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Transaction activity failed";
}

function initialRecords(scope: ReturnType<typeof transactionScope>): {
  readonly requests: readonly TickRequestRecord[];
  readonly cranks: readonly CrankRecord[];
  readonly error: string | null;
} {
  try {
    return {
      requests: loadRequests(scope),
      cranks: loadCranks(scope),
      error: null,
    };
  } catch (cause) {
    return { requests: [], cranks: [], error: message(cause) };
  }
}

function abbreviate(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
