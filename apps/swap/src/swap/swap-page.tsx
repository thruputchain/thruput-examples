import {
  AlertCircleIcon,
  ArrowDownUpIcon,
  ChevronDownIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useEffect, useId, useReducer, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isBrowserLoopback, isLoopbackUrl, type AppConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { buildExactInputSwapTarget } from "@/contracts/router-target";
import { extractAcceptedRequestId } from "@/contracts/swap-event";
import { formatAmount } from "@/domain/amount";
import {
  availableBalance,
  invalidateSnapshotInferenceForOverlap,
  reservedInputForToken,
} from "@/domain/reservations";
import { orientReserves, orderTokens } from "@/domain/tokens";
import { abbreviateAddress } from "@/lib/address";
import {
  deriveSwapQuote,
  formatBasisPoints,
  formatExchangeRate,
  formatSignedTokenAmount,
  formatTokenAmount,
  parseSlippagePercent,
  quoteErrorMessages,
  tokensForDirection,
  type SwapDirection,
} from "@/swap/model";
import { RequestList } from "@/swap/request-list";
import type {
  PoolSnapshot,
  SnapshotReader,
  TokenSnapshot,
} from "@/swap/snapshot";
import { usePoolSnapshot } from "@/swap/use-pool-snapshot";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";
import {
  createRequestRecord,
  dismissTerminalRequest,
  hasLegacyOutstandingRequest,
  loadRequestCollection,
  loadRequestCollectionForUpdate,
  migrateRequestCollection,
  mutateRequestCollection,
  requestCollectionKey,
  saveRequestCollection,
  upsertRequest,
  withRequestCollectionLock,
  type RequestRecord,
} from "@/transactions/request-collection";
import {
  initialWorkflowState,
  workflowReducer,
  type WorkflowState,
} from "@/workflow";
import type {
  RequestObservation,
  RequestObserver,
} from "@/transactions/request-observer";
import { applyObservationBatch } from "@/transactions/request-observer";
import { inferSingleExecutionFromSnapshot } from "@/transactions/execution-fallback";

const SLIPPAGE_PRESETS = [10n, 50n, 100n] as const;
const OBSERVATION_POLL_MS = 2_000;
const POST_TIMEOUT_OBSERVATION_POLL_MS = 10_000;
const OBSERVATION_TIMEOUT_MS = 120_000;

export function SwapPage({
  config,
  readSnapshot,
  requestObserver,
  writeBoundary,
}: {
  config: AppConfig;
  readSnapshot: SnapshotReader;
  requestObserver: RequestObserver;
  writeBoundary: WriteBoundary;
}) {
  const state = usePoolSnapshot(readSnapshot);
  const workspaceHeading = useRef<HTMLHeadingElement>(null);
  const recoveringFromError = useRef(false);

  useEffect(() => {
    if (state.error !== null && state.snapshot === null) {
      recoveringFromError.current = true;
    } else if (state.snapshot !== null && recoveringFromError.current) {
      recoveringFromError.current = false;
      workspaceHeading.current?.focus();
    }
  }, [state.error, state.snapshot]);

  const status = state.isLoading
    ? "Loading pool data."
    : state.isUserRefreshing
      ? "Refreshing quote and pool data."
      : state.error !== null && state.snapshot !== null
        ? "Refresh failed. The previous pool data remains visible."
        : state.snapshot !== null
          ? `Pool data loaded at block ${state.snapshot.chainHeight}.`
          : "Pool data is unavailable.";

  return (
    <div className="isolate min-h-svh text-foreground antialiased">
      <AppHeader
        account={config.accountAddress}
        chainHeight={state.snapshot?.chainHeight ?? null}
        connected={state.snapshot !== null}
        localRpc={isLoopbackUrl(config.rpcUrl)}
        isRefreshing={state.isRefreshing}
        onRefresh={state.refresh}
      />
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      <main
        aria-busy={state.isLoading || state.isRefreshing}
        className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12"
      >
        <div className="flex flex-col gap-6">
          {state.isLoading && state.error === null ? <SwapSkeleton /> : null}
          {state.snapshot === null && state.error !== null ? (
            <ReadError
              message={state.error}
              isRetrying={state.isLoading}
              onRetry={state.refresh}
            />
          ) : null}
          {state.snapshot !== null ? (
            <SwapWorkspace
              config={config}
              snapshot={state.snapshot}
              refreshError={state.error}
              isRefreshing={state.isRefreshing}
              isUserRefreshing={state.isUserRefreshing}
              headingRef={workspaceHeading}
              readSnapshot={readSnapshot}
              requestObserver={requestObserver}
              refreshSnapshot={state.refresh}
              writeBoundary={writeBoundary}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function AppHeader({
  account,
  chainHeight,
  connected,
  localRpc,
  isRefreshing,
  onRefresh,
}: {
  account: Uint8Array;
  chainHeight: bigint | null;
  connected: boolean;
  localRpc: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="border-b border-foreground/10 bg-background/90">
      <div className="mx-auto grid min-h-16 max-w-5xl grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-2 sm:flex sm:justify-between sm:px-6 sm:py-0">
        <a
          href="/"
          aria-label="Homepage"
          className="flex min-h-11 min-w-0 items-center gap-3"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground font-mono text-sm font-medium text-background">
            GH
          </div>
          <div className="min-w-0">
            <div className="font-heading text-base font-semibold tracking-tight">
              Groundhog Swap
            </div>
            <div className="hidden font-mono text-xs text-muted-foreground sm:block">
              {" "}
              / local terminal
            </div>
          </div>
        </a>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="hidden font-mono sm:inline-flex">
            <span
              aria-hidden="true"
              className={
                connected
                  ? "size-1.5 rounded-full bg-local"
                  : "size-1.5 rounded-full bg-muted-foreground"
              }
            />
            {connected && chainHeight !== null
              ? `${localRpc ? "RPC" : "REMOTE"} · block ${chainHeight}`
              : "Connecting"}
          </Badge>
          <Badge
            variant="secondary"
            className="hidden font-mono md:inline-flex"
          >
            {abbreviateAddress(account)}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            aria-label="Refresh pool data"
            disabled={isRefreshing}
            onClick={onRefresh}
            className="relative"
          >
            {isRefreshing ? (
              <Spinner aria-hidden="true" />
            ) : (
              <RefreshCwIcon aria-hidden="true" />
            )}
            <span
              aria-hidden="true"
              className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
            />
          </Button>
        </div>
        <div className="col-span-2 flex items-center justify-between gap-2 sm:hidden">
          <Badge variant="outline" className="font-mono">
            <span
              aria-hidden="true"
              className={
                connected
                  ? "size-1.5 rounded-full bg-local"
                  : "size-1.5 rounded-full bg-muted-foreground"
              }
            />
            {connected ? (localRpc ? "Local RPC" : "Remote RPC") : "Connecting"}
          </Badge>
          <Badge variant="secondary" className="font-mono">
            {abbreviateAddress(account)}
          </Badge>
        </div>
      </div>
    </header>
  );
}

function SwapWorkspace({
  config,
  snapshot,
  refreshError,
  isRefreshing,
  isUserRefreshing,
  headingRef,
  readSnapshot,
  requestObserver,
  refreshSnapshot,
  writeBoundary,
}: {
  config: AppConfig;
  snapshot: PoolSnapshot;
  refreshError: string | null;
  isRefreshing: boolean;
  isUserRefreshing: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  readSnapshot: SnapshotReader;
  requestObserver: RequestObserver;
  refreshSnapshot: () => void;
  writeBoundary: WriteBoundary;
}) {
  const [direction, setDirection] = useState<SwapDirection>("aToB");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [workflow, dispatch] = useReducer(
    workflowReducer,
    initialWorkflowState,
  );
  const [initialRequestState] = useState(() => readInitialRequestState(config));
  const [requests, setRequests] = useState<RequestRecord[]>(
    initialRequestState.requests,
  );
  const [requestStorageError, setRequestStorageError] = useState<string | null>(
    initialRequestState.error,
  );
  const [collectionReady, setCollectionReady] = useState(
    !hasLegacyOutstandingRequest(config),
  );
  const [outstanding, setOutstanding] = useState<RequestRecord | null>(() =>
    selectDisplayRequest(initialRequestState.requests)
  );
  const [isRecoveryRecord, setIsRecoveryRecord] = useState(
    () => selectRecoveryRequest(initialRequestState.requests) !== null,
  );
  const [isAcquiringLock, setIsAcquiringLock] = useState(false);
  const [recoveryCheck, setRecoveryCheck] = useState(0);
  const [isCheckingRecovery, setIsCheckingRecovery] = useState(false);
  const [announcementText, setAnnouncementText] = useState("");
  const [executionOutcomes, setExecutionOutcomes] =
    useState<RequestObservation[]>([]);
  const knownRequestStatuses = useRef(
    new Map(
      initialRequestState.requests.map(({ localId, status }) => [localId, status]),
    ),
  );
  const actionInFlight = useRef(false);
  const workspaceMounted = useRef(false);
  const recoveryAttempts = useRef(new Set<string>());
  const recoveryAttempt = useRef(0);
  const amountId = useId();
  const slippageId = useId();
  const tokens = tokensForDirection(snapshot, direction);
  const reservedInput = reservedInputForToken(
    requests,
    toHex0x(tokens.input.address),
  );
  const slippageResult = parseSlippagePercent(slippage);
  const quote = deriveSwapQuote(
    snapshot,
    direction,
    amount,
    slippageResult.ok ? slippageResult.basisPoints : 50n,
    reservedInput,
  );
  const hasLiquidity = snapshot.reserve0 > 0n && snapshot.reserve1 > 0n;
  const quoteValid = quote.ok && slippageResult.ok;
  const controlsLocked =
    !collectionReady
    || requestStorageError !== null
    || isAcquiringLock
    || isWorkflowLocked(workflow)
    || requests.some(isBlockingRequest);
  const formOutstanding = outstanding !== null && isBlockingRequest(outstanding)
    ? outstanding
    : null;
  const localRpc = isLoopbackUrl(config.rpcUrl) && isBrowserLoopback();
  const nextAnnouncement = transactionAnnouncement({
    workflow,
    outstanding,
    executionOutcomes,
    isAcquiringLock,
    allowanceDifference: quote.ok ? quote.allowanceDifference : null,
  });

  useEffect(() => {
    setAnnouncementText(nextAnnouncement);
  }, [nextAnnouncement]);

  useEffect(() => {
    const observedIds = new Set(
      executionOutcomes.map(({ requestId }) => requestId),
    );
    const newlyTerminal = requests.filter((request) => {
      const previous = knownRequestStatuses.current.get(request.localId);
      return previous !== request.status
        && (isTerminalRequestStatus(request.status)
          || request.status === "indeterminate")
        && (request.requestId === null || !observedIds.has(request.requestId));
    });
    knownRequestStatuses.current = new Map(
      requests.map(({ localId, status }) => [localId, status]),
    );
    if (newlyTerminal.length > 0) {
      setAnnouncementText(terminalRequestAnnouncement(newlyTerminal));
    }
  }, [executionOutcomes, requests]);

  useEffect(() => {
    workspaceMounted.current = true;
    return () => {
      workspaceMounted.current = false;
    };
  }, []);

  const output = quote.ok
    ? formatTokenAmount(quote.amountOut, tokens.output.decimals, 8)
    : "—";
  const validationMessage =
    amount.length === 0 || quote.ok ? null : quoteErrorMessages[quote.error];

  useEffect(() => {
    let cancelled = false;
    void migrateRequestCollection(config).then(
      () => {
        if (cancelled) return;
        const loaded = loadRequestCollection(config);
        setRequests(loaded);
        const recovery = selectRecoveryRequest(loaded);
        setOutstanding(recovery ?? selectDisplayRequest(loaded));
        setIsRecoveryRecord(recovery !== null);
        setCollectionReady(true);
      },
      () => {
        if (cancelled) return;
        setRequestStorageError(
          "Stored request history could not be loaded safely. Clear this site's local data before submitting another swap.",
        );
        setCollectionReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config]);

  useEffect(() => {
    const key = requestCollectionKey(config);
    const reload = (event: StorageEvent) => {
      if (event.key === key) {
        try {
          const loaded = loadRequestCollection(config);
          setRequestStorageError(null);
          setRequests(loaded);
          if (!actionInFlight.current) {
            const recovery = selectRecoveryRequest(loaded);
            setOutstanding(recovery ?? selectDisplayRequest(loaded));
            setIsRecoveryRecord(recovery !== null);
            if (recovery === null) {
              dispatch({ type: "outstandingClearedElsewhere" });
            }
          }
        } catch {
          setRequestStorageError(
            "Stored request history changed but could not be loaded safely.",
          );
        }
      }
    };
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [config]);

  useEffect(() => {
    if (
      !isRecoveryRecord ||
      outstanding === null ||
      outstanding.transactionHash === null ||
      writeBoundary.observe === undefined ||
      !["approving", "submitting", "indeterminate"].includes(outstanding.status)
    )
      return;

    if (outstanding.status === "indeterminate" && recoveryCheck === 0) return;

    const request = outstanding;
    const attemptKey = [
      request.phase,
      request.transactionHash,
      recoveryCheck === 0 ? "automatic" : recoveryCheck,
    ].join(":");
    if (recoveryAttempts.current.has(attemptKey)) return;
    recoveryAttempts.current.add(attemptKey);

    let cancelled = false;
    const attempt = ++recoveryAttempt.current;
    setIsCheckingRecovery(true);
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      try {
        const result = await writeBoundary.observe!(request.transactionHash!);
        if (cancelled) return;
        await withRequestCollectionLock(config, async () => {
          if (cancelled) return;
          let current = loadRequestCollection(config);
          let stored = current.find(({ localId }) => localId === request.localId);
          if (!sameRequestVersion(stored, request)) return;

          if (result.kind === "committedSuccess" && request.phase === "swap") {
            const queuedRequest = requestFromQueuedReceipt(
              request,
              result,
              config,
            );
            const next = saveRequestCollection(
              config,
              upsertRequest(current, queuedRequest),
            );
            if (!cancelled) {
              setRequests(next);
              setOutstanding(queuedRequest);
              setIsRecoveryRecord(false);
              dispatch({ type: "recoveryCompleted" });
            }
            return;
          }

          if (result.kind === "committedSuccess") {
            try {
              const recoveredCollection = await observeAggregateAllowance(
                config,
                readSnapshot,
                requestObserver,
                request.criteria.tokenIn,
                request.intent.amountIn,
                result.receipt.height,
              );
              if (cancelled) return;
              current = recoveredCollection ?? loadRequestCollection(config);
              stored = current.find(({ localId }) => localId === request.localId);
              if (!sameRequestVersion(stored, request)) return;
              if (recoveredCollection !== null) {
                const next = saveRequestCollection(
                  config,
                  current.filter(({ localId }) => localId !== request.localId),
                );
                if (!cancelled) {
                  setRequests(next);
                  setOutstanding(selectDisplayRequest(next));
                  setIsRecoveryRecord(false);
                  dispatch({ type: "recoveryCompleted" });
                  refreshSnapshot();
                }
                return;
              }
            } catch {
              if (cancelled) return;
              // Keep the signed recovery record for another explicit status check.
            }
            current = loadRequestCollection(config);
            stored = current.find(({ localId }) => localId === request.localId);
            if (!sameRequestVersion(stored, request)) return;
          }

          if (
            result.kind === "invalid" ||
            result.kind === "preSubmissionFailure"
          ) {
            const next = saveRequestCollection(
              config,
              current.filter(({ localId }) => localId !== request.localId),
            );
            if (!cancelled) {
              setRequests(next);
              setOutstanding(selectDisplayRequest(next));
              setIsRecoveryRecord(false);
              dispatch({ type: "recoveryCompleted" });
            }
            return;
          }

          const recoveredRequest: RequestRecord =
            result.kind === "committedFailure"
              ? {
                  ...request,
                  status: "committedFailure",
                  transactionHash: result.hash,
                  updatedAt: Date.now(),
                }
              : {
                  ...request,
                  status: "indeterminate",
                  transactionHash: result.hash,
                  updatedAt: Date.now(),
                };
          if (!sameRequestVersion(stored, recoveredRequest)) {
            const next = saveRequestCollection(
              config,
              upsertRequest(current, recoveredRequest),
            );
            if (!cancelled) {
              setRequests(next);
              setOutstanding(recoveredRequest);
              if (result.kind === "committedFailure") {
                dispatch({ type: "recoveryCompleted" });
              }
            }
          }
        });
        if (cancelled) return;
      } catch {
        // A failed recovery read is non-authoritative; preserve the signed record.
      } finally {
        if (
          workspaceMounted.current &&
          recoveryAttempt.current === attempt
        ) {
          setIsCheckingRecovery(false);
        }
      }
    });
    return () => {
      cancelled = true;
      recoveryAttempts.current.delete(attemptKey);
    };
  }, [
    config,
    isRecoveryRecord,
    outstanding,
    readSnapshot,
    recoveryCheck,
    refreshSnapshot,
    writeBoundary,
  ]);

  const observableRequestKey = requests
    .filter(isObservableRequest)
    .map(({ localId, status }) => `${localId}:${status}`)
    .join("|");

  useEffect(() => {
    if (observableRequestKey.length === 0) return;

    let cancelled = false;
    let timer: number | undefined;
    let deadlineTimer: number | undefined;
    let scanInFlight = false;
    let visibleBaselines = new Map<string, { elapsed: number; since: number }>();

    const resetVisibleBaselines = (current: readonly RequestRecord[]) => {
      const since = Date.now();
      visibleBaselines = new Map(
        current
          .filter(({ status }) => status === "queued")
          .map((request) => [
            request.localId,
            { elapsed: request.visibleObservationMs, since },
          ]),
      );
    };
    if (document.visibilityState === "visible") {
      resetVisibleBaselines(loadRequestCollection(config));
    }

    const persistElapsed = async (): Promise<RequestRecord[]> => {
      const baselines = visibleBaselines;
      if (baselines.size === 0) return loadRequestCollection(config);
      const now = Date.now();
      const next = await mutateRequestCollection(config, (current) =>
        current.map((request) => {
          if (request.status !== "queued") return request;
          const baseline = baselines.get(request.localId) ?? {
            elapsed: request.visibleObservationMs,
            since: now,
          };
          const elapsed = Math.min(
            OBSERVATION_TIMEOUT_MS,
            Math.max(
              request.visibleObservationMs,
              baseline.elapsed + Math.max(0, now - baseline.since),
            ),
          );
          return {
            ...request,
            status: elapsed >= OBSERVATION_TIMEOUT_MS
              ? "queuedNotObserved"
              : request.status,
            visibleObservationMs: elapsed,
            updatedAt: elapsed >= OBSERVATION_TIMEOUT_MS
              ? now
              : request.updatedAt,
          };
        })
      );
      if (!cancelled) {
        setRequests(next);
        setOutstanding(selectDisplayRequest(next));
        if (document.visibilityState === "visible") {
          resetVisibleBaselines(next);
          scheduleDeadline(next);
        } else {
          visibleBaselines.clear();
        }
      }
      return next;
    };

    const scheduleDeadline = (current: readonly RequestRecord[]) => {
      if (deadlineTimer !== undefined) window.clearTimeout(deadlineTimer);
      const active = current.filter(({ status }) => status === "queued");
      if (active.length === 0 || document.visibilityState !== "visible") return;
      const remaining = Math.min(
        ...active.map((request) =>
          Math.max(0, OBSERVATION_TIMEOUT_MS - request.visibleObservationMs)
        ),
      );
      deadlineTimer = window.setTimeout(() => void persistElapsed(), remaining);
    };

    const poll = async () => {
      if (
        cancelled
        || scanInFlight
        || document.visibilityState !== "visible"
      ) return;
      scanInFlight = true;
      try {
        const current = await persistElapsed();
        const scanned = current.filter(isObservableRequest);
        if (scanned.length === 0) return;

        let batch;
        try {
          if (requestObserver.scanAll !== undefined) {
            batch = await requestObserver.scanAll(scanned);
          } else {
            const observations = await Promise.all(
              scanned.map((request) => requestObserver.scan(request)),
            );
            batch = {
              observations: observations.filter(
                (observation): observation is RequestObservation =>
                  observation !== null,
              ),
              observedThroughBlock: null,
            };
          }
        } catch {
          const fallbackSnapshot = await readSnapshot();
          const inferred = inferSingleExecutionFromSnapshot(
            scanned,
            fallbackSnapshot,
          );
          if (inferred === null) throw new Error("Execution was not observable");
          batch = {
            observations: [inferred],
            observedThroughBlock: fallbackSnapshot.chainHeight,
          };
        }

        const next = await mutateRequestCollection(config, (latest) =>
          applyObservationBatch(latest, scanned, batch)
        );
        if (!workspaceMounted.current) return;
        setRequests(next);
        setOutstanding(selectDisplayRequest(next));
        const scannedIds = new Set(scanned.map(({ requestId }) => requestId));
        const appliedObservations = batch.observations.filter((observation) =>
          scannedIds.has(observation.requestId)
          && next.some((request) =>
            request.requestId === observation.requestId
            && isTerminalRequestStatus(request.status)
          )
        );
        if (appliedObservations.length > 0) {
          setExecutionOutcomes(appliedObservations);
          refreshSnapshot();
        }
      } catch {
        // Observation is advisory. Preserve every unresolved request.
      } finally {
        scanInFlight = false;
      }
      if (cancelled || document.visibilityState !== "visible") return;
      const current = loadRequestCollection(config);
      const allTimedOut = current.filter(isObservableRequest).every(
        ({ status }) => status === "queuedNotObserved",
      );
      timer = window.setTimeout(
        () => void poll(),
        allTimedOut ? POST_TIMEOUT_OBSERVATION_POLL_MS : OBSERVATION_POLL_MS,
      );
    };

    const visibilityChanged = () => {
      if (document.visibilityState === "visible") {
        const current = loadRequestCollection(config);
        resetVisibleBaselines(current);
        scheduleDeadline(current);
        void poll();
      } else {
        void persistElapsed();
        visibleBaselines.clear();
        if (timer !== undefined) window.clearTimeout(timer);
        if (deadlineTimer !== undefined) window.clearTimeout(deadlineTimer);
      }
    };
    const pageHidden = () => void persistElapsed();

    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", pageHidden);
    scheduleDeadline(loadRequestCollection(config));
    void poll();
    return () => {
      void persistElapsed();
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (deadlineTimer !== undefined) window.clearTimeout(deadlineTimer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", pageHidden);
    };
  }, [
    config,
    observableRequestKey,
    readSnapshot,
    refreshSnapshot,
    requestObserver,
  ]);

  function switchDirection() {
    if (actionInFlight.current) return;
    dispatch({ type: "inputChanged" });
    setExecutionOutcomes([]);
    setDirection((current) => (current === "aToB" ? "bToA" : "aToB"));
    setAmount("");
  }

  function changeAmount(value: string) {
    if (actionInFlight.current) return;
    dispatch({ type: "inputChanged" });
    setExecutionOutcomes([]);
    setAmount(value);
  }

  function changeSlippage(value: string) {
    if (actionInFlight.current) return;
    dispatch({ type: "inputChanged" });
    setExecutionOutcomes([]);
    setSlippage(value);
  }

  async function executeAction() {
    if (
      !workspaceMounted.current
      || !quote.ok
      || !slippageResult.ok
      || actionInFlight.current
      || !localRpc
    ) return;

    const reviewedIntent = {
      amountIn: quote.amountIn,
      amountOutMin: quote.amountOutMin,
    };
    let persisted: RequestRecord | null = null;
    let workflowStarted = false;
    actionInFlight.current = true;
    setIsAcquiringLock(true);
    setExecutionOutcomes([]);

    const beginWorkflow = (needsApproval: boolean) => {
      workflowStarted = true;
      dispatch({ type: "inputChanged" });
      dispatch(
        needsApproval
          ? { type: "approvalRequired", intent: reviewedIntent }
          : { type: "quoteReady", intent: reviewedIntent },
      );
      dispatch({ type: needsApproval ? "approvalStarted" : "submissionStarted" });
    };

    try {
      await withRequestCollectionLock(config, async () => {
        let current = loadRequestCollectionForUpdate(config);
        const blocking = current.find(isBlockingRequest);
        if (blocking !== undefined) {
          setRequests(current);
          setOutstanding(blocking);
          setIsRecoveryRecord(true);
          return;
        }

        const initialSnapshot = await readSnapshot();
        const initialTokens = tokensForDirection(initialSnapshot, direction);
        const tokenIn = toHex0x(initialTokens.input.address);
        const initialReserved = reservedInputForToken(current, tokenIn);
        const initialQuote = deriveSwapQuote(
          initialSnapshot,
          direction,
          amount,
          slippageResult.basisPoints,
          initialReserved,
        );
        if (
          !initialQuote.ok
          || initialQuote.amountIn !== reviewedIntent.amountIn
          || initialQuote.amountOut < reviewedIntent.amountOutMin
        ) {
          throw new Error(
            "The quote changed before submission. Refresh and review it again.",
          );
        }

        const localId = crypto.randomUUID();
        const needsApproval = initialQuote.allowanceDifference !== 0n;
        if (workspaceMounted.current) setIsAcquiringLock(false);
        beginWorkflow(needsApproval);

        const saveRecord = (request: RequestRecord): RequestRecord[] => {
          persisted = request;
          const next = saveRequestCollection(
            config,
            upsertRequest(loadRequestCollection(config), request),
          );
          if (workspaceMounted.current) {
            setRequests(next);
            setOutstanding(request);
            setIsRecoveryRecord(false);
          }
          return next;
        };
        const removeRecord = (request: RequestRecord): RequestRecord[] => {
          const next = saveRequestCollection(
            config,
            loadRequestCollection(config).filter(
              ({ localId: candidate }) => candidate !== request.localId,
            ),
          );
          persisted = null;
          if (workspaceMounted.current) {
            setRequests(next);
            setOutstanding(selectDisplayRequest(next));
            setIsRecoveryRecord(false);
          }
          return next;
        };

        if (needsApproval) {
          let approvalRequest = createRequestRecord(
            {
              status: "approving",
              phase: "approval",
              intent: reviewedIntent,
              transactionHash: null,
              receiptBlock: null,
              requestId: null,
              visibleObservationMs: 0,
              observationBaseline: null,
              criteria: requestCriteria(config, initialTokens),
            },
            { localId },
          );
          saveRecord(approvalRequest);
          const approval = await writeBoundary.execute(
            buildApprovalTarget(
              initialTokens.input.address,
              config.handlerAddress,
              initialQuote.allowanceDifference,
            ),
            {
              onSigned: (hash) => {
                approvalRequest = {
                  ...approvalRequest,
                  transactionHash: hash,
                  updatedAt: Date.now(),
                };
                saveRecord(approvalRequest);
              },
            },
          );
          if (approval.kind !== "committedSuccess") {
            if (
              approval.kind === "indeterminate"
              || approval.kind === "committedFailure"
            ) {
              approvalRequest = {
                ...approvalRequest,
                status: approval.kind === "indeterminate"
                  ? "indeterminate"
                  : "committedFailure",
                transactionHash: approval.hash,
                updatedAt: Date.now(),
              };
              saveRecord(approvalRequest);
            } else {
              removeRecord(approvalRequest);
            }
            if (workspaceMounted.current) {
              if (approval.kind === "indeterminate") {
                setIsRecoveryRecord(true);
              }
              dispatchWriteFailure(dispatch, approval);
            }
            return;
          }

          const approvalObserved = await observeAggregateAllowance(
            config,
            readSnapshot,
            requestObserver,
            tokenIn,
            initialQuote.amountIn,
            approval.receipt.height,
          );
          if (approvalObserved === null) {
            approvalRequest = {
              ...approvalRequest,
              status: "indeterminate",
              transactionHash: approval.hash,
              updatedAt: Date.now(),
            };
            saveRecord(approvalRequest);
            if (workspaceMounted.current) {
              setIsRecoveryRecord(true);
              dispatch({
                type: "transactionIndeterminate",
                transactionHash: approval.hash,
              });
            }
            return;
          }
          current = approvalObserved;
          if (!workspaceMounted.current) return;
          setRequests(current);
          dispatch({ type: "approvalObserved" });
          dispatch({ type: "submissionStarted" });
          refreshSnapshot();
        }

        current = loadRequestCollection(config);
        const submissionSnapshot = await readSnapshot();
        const submissionTokens = tokensForDirection(submissionSnapshot, direction);
        const submissionTokenIn = toHex0x(submissionTokens.input.address);
        const submissionReserved = reservedInputForToken(current, submissionTokenIn);
        const freshQuote = deriveSwapQuote(
          submissionSnapshot,
          direction,
          amount,
          slippageResult.basisPoints,
          submissionReserved,
        );
        if (
          !freshQuote.ok
          || freshQuote.amountIn !== reviewedIntent.amountIn
          || freshQuote.allowanceDifference > 0n
          || freshQuote.amountOut < reviewedIntent.amountOutMin
        ) {
          if (persisted !== null && persisted.phase === "approval") {
            removeRecord(persisted);
          }
          if (workspaceMounted.current) {
            dispatch({
              type: "transactionFailed",
              certainty: "notSubmitted",
              transactionHash: null,
              message:
                "The allowance changed or the quote moved beyond your reviewed slippage limit. Refresh and review it again.",
            });
          }
          return;
        }

        const baseline = observationBaseline(submissionSnapshot, direction);
        let submittingRequest: RequestRecord = persisted === null
          ? createRequestRecord(
              {
                status: "submitting",
                phase: "swap",
                intent: reviewedIntent,
                transactionHash: null,
                receiptBlock: null,
                requestId: null,
                visibleObservationMs: 0,
                observationBaseline: baseline,
                criteria: requestCriteria(config, submissionTokens),
              },
              { localId },
            )
          : {
              ...persisted,
              status: "submitting",
              phase: "swap",
              intent: reviewedIntent,
              transactionHash: null,
              receiptBlock: null,
              requestId: null,
              visibleObservationMs: 0,
              observationBaseline: baseline,
              observedThroughBlock: null,
              snapshotInferenceEligible: true,
              execution: null,
              updatedAt: Date.now(),
              criteria: requestCriteria(config, submissionTokens),
            };
        current = invalidateSnapshotInferenceForOverlap(current, submittingRequest);
        submittingRequest = current.find(
          ({ localId: candidate }) => candidate === localId,
        )!;
        saveRequestCollection(config, current);
        persisted = submittingRequest;
        if (workspaceMounted.current) {
          setRequests(current);
          setOutstanding(submittingRequest);
          setIsRecoveryRecord(false);
          dispatch({
            type: "submissionRefreshed",
            intent: reviewedIntent,
          });
        }

        const submission = await writeBoundary.execute(
          buildExactInputSwapTarget(config.routerAddress, {
            amountIn: freshQuote.amountIn,
            amountOutMin: reviewedIntent.amountOutMin,
            tokenIn: submissionTokens.input.address,
            tokenOut: submissionTokens.output.address,
            recipient: config.accountAddress,
          }),
          {
            onSigned: (hash) => {
              submittingRequest = {
                ...submittingRequest,
                transactionHash: hash,
                updatedAt: Date.now(),
              };
              saveRecord(submittingRequest);
            },
          },
        );

        if (submission.kind === "committedSuccess") {
          const queuedRequest = requestFromQueuedReceipt(
            submittingRequest,
            submission,
            config,
          );
          const next = saveRecord(queuedRequest);
          if (workspaceMounted.current) {
            setAmount("");
            setRequests(next);
            setOutstanding(queuedRequest);
            dispatch({
              type: "requestQueued",
              transactionHash: submission.hash,
              receiptBlock: submission.receipt.height,
            });
            dispatch({ type: "inputChanged" });
          }
          return;
        }

        if (
          submission.kind === "indeterminate"
          || submission.kind === "committedFailure"
        ) {
          submittingRequest = {
            ...submittingRequest,
            status: submission.kind === "indeterminate"
              ? "indeterminate"
              : "committedFailure",
            transactionHash: submission.hash,
            updatedAt: Date.now(),
          };
          saveRecord(submittingRequest);
        } else {
          removeRecord(submittingRequest);
        }
        if (workspaceMounted.current) {
          if (submission.kind === "indeterminate") {
            setIsRecoveryRecord(true);
          }
          dispatchWriteFailure(dispatch, submission);
        }
      });
    } catch (error) {
      const recoverable = persisted as RequestRecord | null;
      if (recoverable !== null) {
        try {
          const localId = recoverable.localId;
          const next = await mutateRequestCollection(config, (current) =>
            current.map((request) =>
              request.localId === localId && !isTerminalRequestStatus(request.status)
                ? {
                    ...request,
                    status: "indeterminate",
                    updatedAt: Date.now(),
                  }
                : request
            )
          );
          persisted = next.find((request) => request.localId === localId) ?? null;
          if (workspaceMounted.current) {
            setRequests(next);
            setOutstanding(persisted ?? selectDisplayRequest(next));
            setIsRecoveryRecord(true);
          }
        } catch {
          setRequestStorageError(
            "The transaction outcome is uncertain and its recovery state could not be saved.",
          );
        }
      }
      if (!workspaceMounted.current) return;
      if (!workflowStarted) {
        beginWorkflow(quote.allowanceDifference !== 0n);
      }
      if (persisted !== null) {
        dispatch({
          type: "transactionIndeterminate",
          transactionHash: persisted.transactionHash,
        });
      } else {
        dispatch({
          type: "transactionFailed",
          certainty: "notSubmitted",
          transactionHash: null,
          message: error instanceof Error
            ? error.message
            : "The submission could not be started.",
        });
      }
    } finally {
      actionInFlight.current = false;
      if (workspaceMounted.current) setIsAcquiringLock(false);
    }
  }

  const applyRequestCollection = (next: RequestRecord[]) => {
    const recovery = selectRecoveryRequest(next);
    setRequests(next);
    setOutstanding(recovery ?? selectDisplayRequest(next));
    setIsRecoveryRecord(recovery !== null);
  };
  const reportRequestUpdateFailure = () => {
    setRequestStorageError("Request history could not be updated safely.");
  };

  const dismissRequest = (localId: string) => {
    void mutateRequestCollection(config, (current) =>
      dismissTerminalRequest(current, localId)
    ).then((next) => {
      applyRequestCollection(next);
      if (
        workflow.status === "error"
        && workflow.certainty === "committed"
        && !next.some(({ status }) => status === "committedFailure")
      ) {
        dispatch({ type: "acknowledgeCommittedFailure" });
      }
    }).catch(reportRequestUpdateFailure);
  };

  const resolveUntrackedRequest = (localId: string) => {
    void mutateRequestCollection(config, (current) =>
      current.filter((request) =>
        request.localId !== localId || request.status !== "queuedUntracked"
      )
    ).then(applyRequestCollection).catch(reportRequestUpdateFailure);
  };

  const confirmPreHashRecovery = (localId: string) => {
    void mutateRequestCollection(config, (current) =>
      current.filter((request) =>
        request.localId !== localId
        || request.transactionHash !== null
        || !isBlockingRequest(request)
      )
    ).then((next) => {
      applyRequestCollection(next);
      dispatch({ type: "recoveryCompleted" });
    }).catch(reportRequestUpdateFailure);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div
        aria-atomic="true"
        aria-label="Transaction status"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {announcementText}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {refreshError !== null ? (
          <Alert variant="destructive">
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>Refresh failed</AlertTitle>
            <AlertDescription>
              The previous snapshot remains visible. {refreshError}
            </AlertDescription>
          </Alert>
        ) : null}
        {requestStorageError !== null ? (
          <Alert variant="destructive">
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>Request history unavailable</AlertTitle>
            <AlertDescription>{requestStorageError}</AlertDescription>
          </Alert>
        ) : null}
        <Card className="shadow-xl shadow-foreground/5 ring-foreground/10 [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)]">
          <CardHeader>
            <CardTitle asChild>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-xl font-semibold tracking-tight focus:outline-none"
              >
                Swap preview
              </h1>
            </CardTitle>
            <CardDescription>
              Exact-input quote from the configured pool.
            </CardDescription>
            <CardAction>
              <SlippageSettings
                id={slippageId}
                value={slippage}
                onChange={changeSlippage}
                result={slippageResult}
                disabled={controlsLocked}
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="relative flex flex-col gap-2">
              <TokenInputPanel
                id={amountId}
                token={tokens.input}
                value={amount}
                error={validationMessage}
                onChange={changeAmount}
                disabled={controlsLocked}
                onMax={() =>
                  changeAmount(
                    formatAmount(
                      availableBalance(tokens.input.balance, reservedInput),
                      tokens.input.decimals,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={`Switch direction to ${tokens.output.symbol} for ${tokens.input.symbol}`}
                onClick={switchDirection}
                disabled={controlsLocked}
                className="relative mx-auto -my-5 rounded-full bg-card shadow-sm"
              >
                <ArrowDownUpIcon aria-hidden="true" />
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                />
              </Button>
              <TokenOutputPanel token={tokens.output} value={output} />
            </div>

            {!hasLiquidity ? (
              <Alert variant="destructive" className="mt-4">
                <AlertCircleIcon aria-hidden="true" />
                <AlertTitle>Empty pool</AlertTitle>
                <AlertDescription>
                  One or both reserves are zero. Add liquidity before quoting a
                  swap.
                </AlertDescription>
              </Alert>
            ) : null}

            <QuoteSummary
              quote={quote.ok ? quote : null}
              input={tokens.input}
              output={tokens.output}
              slippageValid={slippageResult.ok}
            />

            <Button
              type="button"
              disabled={
                !localRpc || !quoteValid || isUserRefreshing || controlsLocked
              }
              onClick={() => void executeAction()}
              className="mt-5 min-h-12 w-full text-base sm:text-sm"
            >
              {controlsLocked ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <LockKeyholeIcon data-icon="inline-start" />
              )}
              {actionLabel({
                amount,
                hasLiquidity,
                quoteValid,
                isRefreshing: isUserRefreshing,
                slippageValid: slippageResult.ok,
                localRpc,
                allowanceDifference: quote.ok
                  ? quote.allowanceDifference
                  : null,
                workflow,
                outstanding: formOutstanding,
                isAcquiringLock,
              })}
            </Button>
            {workflow.status === "error" && formOutstanding === null
              ? <WorkflowStatus workflow={workflow} />
              : null}
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3 p-4">
            <TransactionDetails
              config={config}
              quote={quote.ok ? quote : null}
              input={tokens.input}
              output={tokens.output}
              slippageValid={slippageResult.ok}
            />
          </CardFooter>
        </Card>
        <RequestList
          requests={requests}
          tokenA={snapshot.tokenA}
          tokenB={snapshot.tokenB}
          recoveryRequestId={isRecoveryRecord ? outstanding?.localId ?? null : null}
          isCheckingRecovery={isCheckingRecovery}
          onDismiss={dismissRequest}
          onCheckRecovery={() => setRecoveryCheck((current) => current + 1)}
          onConfirmRecovery={confirmPreHashRecovery}
          onResolveUntracked={resolveUntrackedRequest}
        />
      </div>
    </div>
  );
}

function TokenInputPanel({
  id,
  token,
  value,
  error,
  onChange,
  onMax,
  disabled,
}: {
  id: string;
  token: TokenSnapshot;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onMax: () => void;
  disabled: boolean;
}) {
  return (
    <Field
      data-invalid={error !== null}
      className="gap-3 rounded-xl bg-muted/60 p-4 ring-1 ring-foreground/8 has-focus-within:ring-2 has-focus-within:ring-ring"
    >
      <div className="flex items-center justify-between gap-3">
        <FieldLabel
          htmlFor={id}
          className="font-mono text-xs text-muted-foreground"
        >
          YOU PAY
        </FieldLabel>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          Balance {formatTokenAmount(token.balance, token.decimals, 6)}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <Input
          id={id}
          name="amountIn"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${id}-error` : undefined}
          placeholder="0"
          value={value}
          variant="amount"
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
        <TokenChip token={token} />
      </div>
      <div className="flex min-h-5 items-start justify-between gap-3">
        {error !== null ? (
          <FieldError id={`${id}-error`} className="text-base sm:text-sm">
            {error}
          </FieldError>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onMax}
          disabled={disabled}
          className="relative shrink-0 font-mono"
        >
          MAX
          <span
            aria-hidden="true"
            className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
          />
        </Button>
      </div>
    </Field>
  );
}

function TokenOutputPanel({
  token,
  value,
}: {
  token: TokenSnapshot;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-muted/60 p-4 ring-1 ring-foreground/8">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs text-muted-foreground">YOU RECEIVE</p>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          Balance {formatTokenAmount(token.balance, token.decimals, 6)}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <output
          aria-label="Estimated output"
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-3xl font-medium tracking-tight tabular-nums sm:text-4xl"
        >
          {value}
        </output>
        <TokenChip token={token} />
      </div>
      <p className="min-h-5 text-base text-muted-foreground sm:text-sm">
        Estimated from current reserves.
      </p>
    </div>
  );
}

function TokenChip({ token }: { token: TokenSnapshot }) {
  return (
    <Badge
      variant="outline"
      className="h-9 shrink-0 bg-card px-2.5 font-mono text-sm"
    >
      {token.symbol}
    </Badge>
  );
}

function SlippageSettings({
  id,
  value,
  onChange,
  result,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  result: ReturnType<typeof parseSlippagePercent>;
  disabled: boolean;
}) {
  const selectedPreset = result.ok
    ? SLIPPAGE_PRESETS.find(
        (preset) => preset === result.basisPoints,
      )?.toString()
    : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="relative font-mono"
        >
          <Settings2Icon data-icon="inline-start" />
          {result.ok ? `${formatBasisPoints(result.basisPoints)}%` : "Slippage"}
          <span
            aria-hidden="true"
            className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={`${id}-title`}
        className="w-[calc(100vw-2rem)] max-w-80 gap-4 p-4"
      >
        <PopoverHeader>
          <PopoverTitle id={`${id}-title`}>Slippage tolerance</PopoverTitle>
          <PopoverDescription className="text-base sm:text-sm">
            Set the minimum acceptable output for this preview.
          </PopoverDescription>
        </PopoverHeader>
        <ToggleGroup
          type="single"
          variant="outline"
          value={selectedPreset ?? ""}
          onValueChange={(next) => {
            if (next !== "") onChange(formatBasisPoints(BigInt(next)));
          }}
          className="grid w-full grid-cols-3"
        >
          {SLIPPAGE_PRESETS.map((preset) => (
            <ToggleGroupItem
              key={preset.toString()}
              value={preset.toString()}
              disabled={disabled}
              className="min-h-12 w-full font-mono sm:min-h-9"
            >
              {formatBasisPoints(preset)}%
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Field data-invalid={!result.ok} className="gap-2">
          <FieldLabel htmlFor={id}>Custom percentage</FieldLabel>
          <div className="relative">
            <Input
              id={id}
              name="slippage"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={!result.ok}
              aria-describedby={!result.ok ? `${id}-error` : undefined}
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              className="h-12 pr-9 font-mono tabular-nums sm:h-9"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">
              %
            </span>
          </div>
          {!result.ok ? (
            <FieldError id={`${id}-error`}>
              Enter more than 0% and no more than 50%, using at most two
              decimals.
            </FieldError>
          ) : null}
        </Field>
        {result.ok && result.basisPoints > 500n ? (
          <Alert variant="destructive">
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>High slippage</AlertTitle>
            <AlertDescription>
              More than 5% can produce a materially worse execution price.
            </AlertDescription>
          </Alert>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function QuoteSummary({
  quote,
  input,
  output,
  slippageValid,
}: {
  quote: Extract<ReturnType<typeof deriveSwapQuote>, { ok: true }> | null;
  input: TokenSnapshot;
  output: TokenSnapshot;
  slippageValid: boolean;
}) {
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-base sm:text-sm">
      <dt className="font-medium text-foreground">Estimated output</dt>
      <dd className="text-right text-muted-foreground tabular-nums">
        {quote === null
          ? "—"
          : `${formatTokenAmount(quote.amountOut, output.decimals, 8)} ${output.symbol}`}
      </dd>
      <dt className="font-medium text-foreground">Minimum output</dt>
      <dd className="text-right text-muted-foreground tabular-nums">
        {quote === null || !slippageValid
          ? "—"
          : `${formatTokenAmount(quote.amountOutMin, output.decimals, 8)} ${output.symbol}`}
      </dd>
      <dt className="font-medium text-foreground">Rate</dt>
      <dd className="text-right text-muted-foreground tabular-nums">
        {quote === null
          ? "—"
          : `1 ${input.symbol} = ${formatExchangeRate({
              amountIn: quote.amountIn,
              inputDecimals: input.decimals,
              amountOut: quote.amountOut,
              outputDecimals: output.decimals,
            })} ${output.symbol}`}
      </dd>
      <dt className="font-medium text-foreground">Price impact</dt>
      <dd className="text-right text-muted-foreground tabular-nums">
        {quote?.priceImpactBps === null || quote === null
          ? "—"
          : `${formatBasisPoints(quote.priceImpactBps)}%`}
      </dd>
      <dt className="font-medium text-foreground">Swap fee</dt>
      <dd className="text-right text-muted-foreground">0.3%</dd>
    </dl>
  );
}

function TransactionDetails({
  config,
  quote,
  input,
  output,
  slippageValid,
}: {
  config: AppConfig;
  quote: Extract<ReturnType<typeof deriveSwapQuote>, { ok: true }> | null;
  input: TokenSnapshot;
  output: TokenSnapshot;
  slippageValid: boolean;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="group min-h-12 w-full justify-between sm:min-h-9"
        >
          Transaction details
          <ChevronDownIcon
            aria-hidden="true"
            className="group-data-open:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 px-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 font-mono text-xs">
          <dt className="font-medium text-foreground">Rate</dt>
          <dd className="text-right text-muted-foreground tabular-nums">
            {quote === null
              ? "—"
              : `1 ${input.symbol} = ${formatExchangeRate({
                  amountIn: quote.amountIn,
                  inputDecimals: input.decimals,
                  amountOut: quote.amountOut,
                  outputDecimals: output.decimals,
                })} ${output.symbol}`}
          </dd>
          <dt className="font-medium text-foreground">Swap fee</dt>
          <dd className="text-right text-muted-foreground">0.3%</dd>
          <dt className="font-medium text-foreground">Price impact</dt>
          <dd className="text-right text-muted-foreground tabular-nums">
            {quote?.priceImpactBps === null || quote === null
              ? "—"
              : `${formatBasisPoints(quote.priceImpactBps)}%`}
          </dd>
          <dt className="font-medium text-foreground">Allowance change</dt>
          <dd className="text-right text-muted-foreground tabular-nums">
            {quote === null
              ? "—"
              : `${formatSignedTokenAmount(quote.allowanceDifference, input.decimals, 8)} ${input.symbol}`}
          </dd>
          <dt className="font-medium text-foreground">Protected output</dt>
          <dd className="text-right text-muted-foreground tabular-nums">
            {quote === null || !slippageValid
              ? "—"
              : `${formatTokenAmount(quote.amountOutMin, output.decimals, 8)} ${output.symbol}`}
          </dd>
          <dt className="font-medium text-foreground">Handler</dt>
          <dd className="text-right text-muted-foreground">
            {abbreviateAddress(config.handlerAddress)}
          </dd>
          <dt className="font-medium text-foreground">Pair</dt>
          <dd className="text-right text-muted-foreground">
            {abbreviateAddress(config.pairAddress)}
          </dd>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SwapSkeleton() {
  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]"
      aria-label="Loading pool"
    >
      <Card className="[--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)]">
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
      <Skeleton className="hidden h-72 rounded-xl lg:block" />
    </div>
  );
}

function ReadError({
  message,
  isRetrying,
  onRetry,
}: {
  message: string | null;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardHeader>
        <CardTitle asChild>
          <h1>RPC unavailable</h1>
        </CardTitle>
        <CardDescription>
          Check the configured endpoint and confirm that setup completed on the
          expected ledger.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Configured pool data could not be loaded</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          variant="outline"
          disabled={isRetrying}
          onClick={onRetry}
          className="min-h-12 sm:min-h-9"
        >
          {isRetrying ? (
            <Spinner data-icon="inline-start" aria-hidden="true" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          {isRetrying ? "Retrying" : "Retry"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function actionLabel(params: {
  amount: string;
  hasLiquidity: boolean;
  quoteValid: boolean;
  isRefreshing: boolean;
  slippageValid: boolean;
  localRpc: boolean;
  allowanceDifference: bigint | null;
  workflow: WorkflowState;
  outstanding: RequestRecord | null;
  isAcquiringLock: boolean;
}): string {
  if (params.isAcquiringLock) {
    return params.allowanceDifference === 0n
      ? "Submitting swap"
      : "Approving swap";
  }
  if (!params.localRpc) return "Signing requires a local RPC";
  if (params.outstanding?.status === "queuedUntracked")
    return "Queued; request ID unavailable";
  if (params.outstanding?.status === "queuedNotObserved")
    return "Queued; execution not observed";
  if (params.outstanding?.status === "committedFailure")
    return "Transaction failed";
  if (params.workflow.status === "approving") return "Approving swap";
  if (params.workflow.status === "readyToSwap") return "Swap";
  if (params.workflow.status === "submitting") return "Submitting swap";
  if (params.workflow.status === "queued") return "Queued for execution";
  if (params.workflow.status === "queuedNotObserved")
    return "Queued; execution not observed";
  if (params.workflow.status === "indeterminate") return "Outcome is uncertain";
  if (params.workflow.status === "error")
    return params.workflow.retryAllowed ? "Try again" : "Transaction failed";
  if (params.outstanding !== null) {
    if (params.outstanding.status === "queued") return "Queued for execution";
    return "Outstanding request recorded";
  }
  if (params.isRefreshing) return "Refreshing quote";
  if (!params.hasLiquidity) return "Pool has no liquidity";
  if (params.amount.length === 0) return "Enter an amount";
  if (!params.slippageValid) return "Check slippage";
  if (!params.quoteValid) return "Check amount";
  return params.allowanceDifference === 0n ? "Swap" : "Approve & swap";
}

function isWorkflowLocked(workflow: WorkflowState): boolean {
  return (
    [
      "approving",
      "submitting",
      "indeterminate",
    ].includes(workflow.status) ||
    (workflow.status === "error" && !workflow.retryAllowed)
  );
}

function WorkflowStatus({ workflow }: { workflow: WorkflowState }) {
  if (workflow.status !== "error") return null;
  return (
    <Alert className="mt-4" role="alert" variant="destructive">
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Transaction issue</AlertTitle>
      <AlertDescription>{workflow.message}</AlertDescription>
    </Alert>
  );
}

function transactionAnnouncement(params: {
  workflow: WorkflowState;
  outstanding: RequestRecord | null;
  executionOutcomes: readonly RequestObservation[];
  isAcquiringLock: boolean;
  allowanceDifference: bigint | null;
}): string {
  if (params.executionOutcomes.length > 0) {
    const observed = params.executionOutcomes.filter(
      ({ kind }) => kind === "executionObserved",
    ).length;
    const inferred = params.executionOutcomes.filter(
      ({ kind }) => kind === "executionInferred",
    ).length;
    const failed = params.executionOutcomes.length - observed - inferred;
    if (params.executionOutcomes.length === 1) {
      if (observed === 1) return "Execution observed.";
      if (inferred === 1) {
        return "Execution inferred from updated balances and reserves.";
      }
      return "Queued request failed during execution.";
    }
    return `${params.executionOutcomes.length} request updates: ${observed} observed, ${inferred} inferred, ${failed} failed.`;
  }
  if (params.isAcquiringLock) {
    return params.allowanceDifference === 0n
      ? "Submitting swap."
      : "Approving swap.";
  }

  const activeWorkflow = ![
    "idle",
    "quoting",
    "readyToApprove",
    "readyToSwap",
  ].includes(params.workflow.status);
  const persistedStatus = params.outstanding?.status;
  const persistedStatusOverridesWorkflow =
    persistedStatus === "committedFailure" ||
    persistedStatus === "queuedNotObserved" ||
    persistedStatus === "queuedUntracked";
  const status = persistedStatusOverridesWorkflow
    ? persistedStatus
    : activeWorkflow
      ? params.workflow.status
      : persistedStatus;
  switch (status) {
    case "approving":
      return "Approving swap.";
    case "submitting":
      return "Submitting swap.";
    case "queued":
      return "Swap queued for execution.";
    case "queuedNotObserved":
      return "Swap remains queued; execution was not observed.";
    case "queuedUntracked":
      return "Swap queued, but its request ID is unavailable.";
    case "indeterminate":
      return "";
    case "committedFailure":
      return "";
    case "executionObserved":
      return "Execution observed.";
    case "error":
      return "";
    default:
      return "";
  }
}

function terminalRequestAnnouncement(requests: readonly RequestRecord[]): string {
  const indeterminate = requests.filter(
    ({ status }) => status === "indeterminate",
  ).length;
  const executed = requests.filter(({ status }) => status === "executed").length;
  const failed = requests.length - executed - indeterminate;
  if (requests.length === 1) {
    if (indeterminate === 1) {
      return "Transaction outcome uncertain. Do not retry automatically.";
    }
    return executed === 1
      ? "Request execution recorded."
      : "Request failed.";
  }
  return `${requests.length} request updates: ${executed} executed, ${failed} failed, ${indeterminate} uncertain.`;
}

function requestCriteria(
  config: AppConfig,
  tokens: { input: TokenSnapshot; output: TokenSnapshot },
): RequestRecord["criteria"] {
  return {
    pairAddress: toHex0x(config.pairAddress),
    handlerAddress: toHex0x(config.handlerAddress),
    driverAddress: toHex0x(config.driverAddress),
    recipient: toHex0x(config.accountAddress),
    tokenIn: toHex0x(tokens.input.address),
    tokenOut: toHex0x(tokens.output.address),
  };
}

function sameRequestVersion(
  current: RequestRecord | undefined,
  expected: RequestRecord,
): boolean {
  return current?.localId === expected.localId
    && current.status === expected.status
    && current.phase === expected.phase
    && current.transactionHash === expected.transactionHash
    && current.receiptBlock === expected.receiptBlock
    && current.requestId === expected.requestId;
}

function readInitialRequestState(config: AppConfig): {
  requests: RequestRecord[];
  error: string | null;
} {
  try {
    return { requests: loadRequestCollection(config), error: null };
  } catch {
    return {
      requests: [],
      error:
        "Stored request history could not be loaded safely. Clear this site's local data before submitting another swap.",
    };
  }
}

function selectRecoveryRequest(
  requests: readonly RequestRecord[],
): RequestRecord | null {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index]!;
    if (isBlockingRequest(request)) return request;
  }
  return null;
}

function selectDisplayRequest(
  requests: readonly RequestRecord[],
): RequestRecord | null {
  const recovery = selectRecoveryRequest(requests);
  if (recovery !== null) return recovery;
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index]!;
    if (!isTerminalRequestStatus(request.status)) return request;
  }
  return null;
}

function isBlockingRequest(request: RequestRecord): boolean {
  return request.status === "approving"
    || request.status === "submitting"
    || request.status === "indeterminate"
    || request.status === "committedFailure";
}

function isObservableRequest(request: RequestRecord): boolean {
  return (request.status === "queued" || request.status === "queuedNotObserved")
    && request.requestId !== null
    && request.receiptBlock !== null;
}

function isTerminalRequestStatus(status: RequestRecord["status"]): boolean {
  return status === "committedFailure" || status === "executed" || status === "failed";
}

function observationBaseline(
  snapshot: PoolSnapshot,
  direction: SwapDirection,
): NonNullable<RequestRecord["observationBaseline"]> {
  const tokens = tokensForDirection(snapshot, direction);
  const inputIndex = orderTokens(
    tokens.input.address,
    tokens.output.address,
  ).inputIndex;
  const reserves = orientReserves(
    [snapshot.reserve0, snapshot.reserve1],
    inputIndex,
  );
  return {
    chainHeight: snapshot.chainHeight,
    inputBalance: tokens.input.balance,
    outputBalance: tokens.output.balance,
    inputAllowance: tokens.input.allowance,
    reserveIn: reserves.reserveIn,
    reserveOut: reserves.reserveOut,
  };
}

function requestFromQueuedReceipt(
  request: RequestRecord,
  result: Extract<WriteResult, { kind: "committedSuccess" }>,
  config: AppConfig,
): RequestRecord {
  try {
    return {
      ...request,
      status: "queued",
      transactionHash: result.hash,
      receiptBlock: result.receipt.height,
      requestId: toHex0x(
        extractAcceptedRequestId(result.receipt, config.driverAddress),
      ),
      visibleObservationMs: 0,
      observedThroughBlock: null,
      updatedAt: Date.now(),
    };
  } catch {
    return {
      ...request,
      status: "queuedUntracked",
      transactionHash: result.hash,
      receiptBlock: result.receipt.height,
      requestId: null,
      visibleObservationMs: 0,
      observedThroughBlock: null,
      updatedAt: Date.now(),
    };
  }
}

function dispatchWriteFailure(
  dispatch: React.Dispatch<Parameters<typeof workflowReducer>[1]>,
  result: Exclude<WriteResult, { kind: "committedSuccess" }>,
): void {
  if (result.kind === "indeterminate") {
    dispatch({
      type: "transactionIndeterminate",
      transactionHash: result.hash,
    });
    return;
  }
  if (result.kind === "preSubmissionFailure") {
    dispatch({
      type: "transactionFailed",
      certainty: "notSubmitted",
      transactionHash: null,
      message: result.message,
    });
  } else if (result.kind === "invalid") {
    dispatch({
      type: "transactionFailed",
      certainty: "invalid",
      transactionHash: result.hash,
      message: result.reason,
    });
  } else {
    dispatch({
      type: "transactionFailed",
      certainty: "committed",
      transactionHash: result.hash,
      message:
        "The transaction committed without a successful execution result.",
    });
  }
}

async function observeAggregateAllowance(
  config: AppConfig,
  readSnapshot: SnapshotReader,
  requestObserver: RequestObserver,
  tokenIn: string,
  amountIn: bigint,
  receiptBlock: bigint,
): Promise<RequestRecord[] | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      let current = loadRequestCollection(config);
      const observable = current.filter((request) =>
        isObservableRequest(request) && request.criteria.tokenIn === tokenIn
      );
      if (observable.length > 0) {
        try {
          const batch = requestObserver.scanAll !== undefined
            ? await requestObserver.scanAll(observable)
            : {
              observations: (await Promise.all(
                observable.map((request) => requestObserver.scan(request)),
              )).filter(
                (observation): observation is RequestObservation =>
                  observation !== null,
              ),
              observedThroughBlock: null,
            };
          current = saveRequestCollection(
            config,
            applyObservationBatch(current, observable, batch),
          );
        } catch {
          // Allowance reads can still prove sufficient coverage if events lag.
        }
      }
      const snapshot = await readSnapshot();
      const target = reservedInputForToken(current, tokenIn) + amountIn;
      const inputToken = tokenIn === toHex0x(snapshot.tokenA.address)
        ? snapshot.tokenA
        : tokenIn === toHex0x(snapshot.tokenB.address)
          ? snapshot.tokenB
          : null;
      if (
        snapshot.chainHeight >= receiptBlock &&
        inputToken !== null && inputToken.allowance >= target
      ) {
        return current;
      }
    } catch {
      // Retry short-lived read failures while waiting for the committed allowance.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return null;
}
