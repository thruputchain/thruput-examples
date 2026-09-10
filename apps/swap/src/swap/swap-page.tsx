import {
  AlertCircleIcon,
  ArrowDownUpIcon,
  ChevronDownIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useEffect, useId, useReducer, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AllowanceCleanupCard } from "@/components/allowance-cleanup-card";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { SlippageSettings } from "@/components/slippage-settings";
import { useProcessingMode } from "@/components/processing-mode";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { AppConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import {
  buildProcessRequestsTarget,
  decodeRequestsProcessedSummary,
} from "@/contracts/driver-target";
import { RequestAccepted } from "@/contracts/generated/swap-driver";
import { swapFailureMessage } from "@/contracts/failure-message";
import { buildExactInputSwapTarget } from "@/contracts/router-target";
import { formatAmount } from "@/domain/amount";
import { requiredAllowanceFor } from "@/domain/allowance-exposure";
import {
  availableBalance,
  hasExecutionExposure,
  invalidateSnapshotInferenceForOverlap,
  reservedInputForToken,
} from "@/domain/reservations";
import { orientReserves, orderTokens } from "@/domain/tokens";
import { AmmPage } from "@/pools/amm-page";
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
import { applyCreationReceipt } from "@/transactions/creation-observer";
import { applyLiquidityReceipt } from "@/transactions/liquidity-executor";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";
import {
  hasBlockingLiquidityTransaction,
  hasLiquidityExecutionExposure,
  isAccountLiquidityOperationKey,
  loadAccountLiquidityOperations,
  loadLiquidityOperations,
  reservedLiquidityTokenAmount,
  saveLiquidityOperations,
  type LiquidityOperation,
} from "@/transactions/liquidity-operation";
import {
  hasBlockingCreationTransaction,
  hasCreationExecutionExposure,
  isAccountCreationWorkflowKey,
  loadAccountCreationWorkflows,
  reservedCreationToken,
  saveCreationWorkflow,
  type CreationWorkflow,
} from "@/transactions/creation-workflow";
import {
  allowanceCleanupKey,
  hasBlockingAllowanceCleanup,
} from "@/transactions/allowance-cleanup";
import { loadRequiredAllowance } from "@/transactions/account-allowance";
import {
  isAccountOutstandingRequestKey,
  outstandingRequestKey,
} from "@/transactions/outstanding-request";
import {
  isAccountCrankAttemptKey,
  crankAttemptKey,
  createCrankAttempt,
  isBlockingCrankAttempt,
  loadAccountCrankAttempts,
  loadCrankAttempt,
  saveCrankAttempt,
  type CrankAttempt,
} from "@/transactions/crank-attempt";
import {
  createRequestRecord,
  dismissTerminalRequest,
  hasLegacyOutstandingRequest,
  isAccountRequestCollectionKey,
  loadAccountRequestRecords,
  loadRequestCollection,
  loadRequestCollectionForUpdate,
  migrateRequestCollection,
  mutateRequestCollection,
  needsQueueProcessing,
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
import {
  applyObservationBatch,
  observationsFromReceipt,
} from "@/transactions/request-observer";
import { inferSingleExecutionFromSnapshot } from "@/transactions/execution-fallback";

const OBSERVATION_POLL_MS = 2_000;
const POST_TIMEOUT_OBSERVATION_POLL_MS = 10_000;
const OBSERVATION_TIMEOUT_MS = 120_000;
const MAX_PENDING_SWAP_REQUESTS = 10;

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
    <AmmPage
      title={`Swap ${config.tokenASymbol} / ${config.tokenBSymbol}`}
      description="Trade an exact input amount against this pool's current reserves."
      actions={
        <Button
          size="sm"
          variant="outline"
          aria-label="Refresh pool data"
          disabled={state.isRefreshing}
          onClick={state.refresh}
        >
          {state.isRefreshing ? (
            <Spinner data-icon="inline-start" aria-hidden="true" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
          )}
          Refresh
        </Button>
      }
    >
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <BlockchainIdentifier kind="address" value={toHex0x(config.tokenAAddress)} label="Token A address" />
        <BlockchainIdentifier kind="address" value={toHex0x(config.tokenBAddress)} label="Token B address" />
      </div>
      <div
        aria-busy={state.isLoading || state.isRefreshing}
        className="flex flex-col gap-6"
      >
        {state.isLoading && state.error === null ? <SwapSkeleton /> : null}
        {state.snapshot === null && state.error !== null ? (
          <ReadError
            message={state.error}
            isRetrying={state.isLoading}
            onRetry={state.refresh}
          />
        ) : null}
        {state.snapshot === null ? (
          <AllowanceCleanupCard
            config={config}
            snapshot={null}
            readSnapshot={readSnapshot}
            writer={writeBoundary}
            onRefresh={state.refresh}
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
    </AmmPage>
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
  const [initialCrankState] = useState(() => readInitialCrankState(config));
  const [crankAttempt, setCrankAttempt] = useState<CrankAttempt | null>(
    initialCrankState.attempt,
  );
  const [crankStorageError, setCrankStorageError] = useState<string | null>(
    initialCrankState.error,
  );
  const [isCranking, setIsCranking] = useState(false);
  const { mode: processingMode, setMode: setProcessingMode } = useProcessingMode();
  const manualProcessing = processingMode === "manual";
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
  const [, refreshAccountSafety] = useReducer((revision) => revision + 1, 0);
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
  const accountSafety = readAccountSafetyState(config);
  const reservedInput = reservedInputForToken(
    accountSafety.requests,
    toHex0x(tokens.input.address),
  ) + reservedCreationToken(
    accountSafety.creationWorkflows,
    toHex0x(tokens.input.address),
  ) + reservedLiquidityTokenAmount(
    accountSafety.liquidityOperations,
    toHex0x(tokens.input.address),
  );
  const poolReservedInput = requiredAllowanceFor({
    requests: accountSafety.requests,
    liquidityOperations: accountSafety.liquidityOperations,
    creationWorkflows: accountSafety.creationWorkflows,
  }, toHex0x(tokens.input.address), toHex0x(config.handlerAddress));
  const slippageResult = parseSlippagePercent(slippage);
  const quote = deriveSwapQuote(
    snapshot,
    direction,
    amount,
    slippageResult.ok ? slippageResult.basisPoints : 50n,
    reservedInput,
    poolReservedInput,
  );
  const hasLiquidity = snapshot.reserve0 > 0n && snapshot.reserve1 > 0n;
  const quoteValid = quote.ok && slippageResult.ok;
  const requestQueueFull = accountSafety.requests.filter(hasExecutionExposure).length
      + accountSafety.creationWorkflows.filter(hasCreationExecutionExposure).length
      + accountSafety.liquidityOperations.filter(hasLiquidityExecutionExposure).length
    >= MAX_PENDING_SWAP_REQUESTS;
  const crossPoolRequestBlocked = accountSafety.requests.some((request) =>
    isBlockingRequest(request)
    && request.criteria.handlerAddress !== toHex0x(config.handlerAddress)
  );
  const crossPoolCrankBlocked = accountSafety.crankAttempts.some((attempt) =>
    isBlockingCrankAttempt(attempt)
    && (attempt.driverAddress !== toHex0x(config.driverAddress)
      || crankAttempt === null
      || attempt.id !== crankAttempt.id)
  );
  const creationTransactionBlocked = accountSafety.creationWorkflows.some(
    hasBlockingCreationTransaction,
  );
  const liquidityTransactionBlocked = accountSafety.liquidityOperations.some(
    hasBlockingLiquidityTransaction,
  );
  const controlsLocked =
    !collectionReady
    || requestStorageError !== null
    || accountSafety.error !== null
    || (!manualProcessing && crankStorageError !== null)
    || isAcquiringLock
    || isWorkflowLocked(workflow)
    || accountSafety.requests.some(isBlockingRequest)
    || accountSafety.crankAttempts.some(isBlockingCrankAttempt)
    || accountSafety.allowanceCleanupBlocked
    || creationTransactionBlocked
    || liquidityTransactionBlocked;
  const modeLocked = isAcquiringLock
    || isCranking
    || isCheckingRecovery
    || ["approving", "submitting", "indeterminate"].includes(workflow.status)
    || accountSafety.crankAttempts.some(isBlockingCrankAttempt)
    || accountSafety.allowanceCleanupBlocked
    || creationTransactionBlocked
    || liquidityTransactionBlocked
    || accountSafety.requests.some((request) =>
      request.status === "approving"
      || request.status === "submitting"
      || request.status === "indeterminate"
    );
  const crankRecoveryDisabled = isAcquiringLock
    || isCheckingRecovery
    || ["approving", "submitting"].includes(workflow.status)
    || accountSafety.requests.some((request) =>
      request.status === "approving" || request.status === "submitting"
    );
  const formOutstanding = outstanding !== null && isBlockingRequest(outstanding)
    ? outstanding
    : null;
  const nextAnnouncement = transactionAnnouncement({
    workflow,
    outstanding,
    executionOutcomes,
    crankAttempt,
    isCranking,
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
      if (
        event.key === null
        || isAccountRequestCollectionKey(config, event.key)
        || isAccountOutstandingRequestKey(config, event.key)
        || isAccountCreationWorkflowKey(config, event.key)
        || isAccountLiquidityOperationKey(config, event.key)
        || event.key === allowanceCleanupKey(config)
      ) {
        refreshAccountSafety();
      }
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
      } else if (
        event.key === null
        || event.key === outstandingRequestKey(config)
      ) {
        void migrateRequestCollection(config).then(
          (loaded) => {
            setRequestStorageError(null);
            setRequests(loaded);
            if (!actionInFlight.current) {
              const recovery = selectRecoveryRequest(loaded);
              setOutstanding(recovery ?? selectDisplayRequest(loaded));
              setIsRecoveryRecord(recovery !== null);
            }
          },
          () => {
            setRequestStorageError(
              "Stored request history changed but could not be migrated safely.",
            );
          },
        );
      }
    };
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [config]);

  useEffect(() => {
    const key = crankAttemptKey(config);
    const reload = (event: StorageEvent) => {
      if (event.key === null || isAccountCrankAttemptKey(config, event.key)) {
        refreshAccountSafety();
      }
      if (
        event.key !== null
        && event.key !== key
      ) return;
      try {
        setCrankAttempt(loadCrankAttempt(config));
        setCrankStorageError(null);
      } catch {
        setCrankStorageError(
          "Queue-processing state changed but could not be loaded safely.",
        );
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
                  transactionHash: result.hash ?? request.transactionHash,
                  updatedAt: Date.now(),
                }
              : {
                  ...request,
                  status: "indeterminate",
                  transactionHash: result.hash ?? request.transactionHash,
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

        let batch: ReturnType<typeof observationsFromReceipt> | undefined;
        let fallbackSnapshot: PoolSnapshot | null = null;
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
          fallbackSnapshot = await readSnapshot();
          const inferred = inferSingleExecutionFromSnapshot(
            current.filter(hasExecutionExposure),
            fallbackSnapshot,
          );
          if (inferred === null) throw new Error("Execution was not observable");
          batch = {
            observations: [inferred],
            observedThroughBlock: fallbackSnapshot.chainHeight,
          };
        }

        const inferenceSnapshot = fallbackSnapshot;
        const next = await mutateRequestCollection(config, (latest) => {
          if (inferenceSnapshot === null) {
            return applyObservationBatch(latest, scanned, batch);
          }
          const revalidated = inferSingleExecutionFromSnapshot(
            latest.filter(hasExecutionExposure),
            inferenceSnapshot,
          );
          if (
            revalidated === null
            || revalidated.requestId !== batch.observations[0]?.requestId
          ) return latest;
          return applyObservationBatch(latest, scanned, {
            observations: [revalidated],
            observedThroughBlock: inferenceSnapshot.chainHeight,
          });
        });
        if (!workspaceMounted.current) return;
        setRequests(next);
        setOutstanding(selectDisplayRequest(next));
        const scannedIds = new Set(scanned.map(({ requestId }) => requestId));
        const appliedObservations = batch.observations.filter((observation) =>
          scannedIds.has(observation.requestId)
          && next.some((request) => requestMatchesObservation(request, observation))
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
    ) return;

    const reviewedIntent = {
      amountIn: quote.amountIn,
      amountOutMin: quote.amountOutMin,
    };
    const automaticProcessing = !manualProcessing;
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
        const accountRequests = loadAccountRequestRecords(config);
        const accountCrankAttempts = loadAccountCrankAttempts(config);
        const creationWorkflows = loadAccountCreationWorkflows(config);
        const liquidityOperations = loadAccountLiquidityOperations(config);
        const expectedCrankAttempt = loadCrankAttempt(config);
        if (
          accountCrankAttempts.some(isBlockingCrankAttempt)
          || hasBlockingAllowanceCleanup(config)
          || creationWorkflows.some(hasBlockingCreationTransaction)
          || liquidityOperations.some(hasBlockingLiquidityTransaction)
        ) {
          setRequests(current);
          setCrankAttempt(expectedCrankAttempt);
          return;
        }
        const blocking = accountRequests.find(isBlockingRequest);
        if (blocking !== undefined) {
          setRequests(current);
          if (blocking.criteria.handlerAddress === toHex0x(config.handlerAddress)) {
            setOutstanding(blocking);
            setIsRecoveryRecord(true);
          }
          return;
        }
        if (
          accountRequests.filter(hasExecutionExposure).length
              + creationWorkflows.filter(hasCreationExecutionExposure).length
              + liquidityOperations.filter(hasLiquidityExecutionExposure).length
            >= MAX_PENDING_SWAP_REQUESTS
        ) {
          setRequests(current);
          return;
        }

        const initialSnapshot = await readSnapshot();
        const initialTokens = tokensForDirection(initialSnapshot, direction);
        const tokenIn = toHex0x(initialTokens.input.address);
        const initialReserved = reservedInputForToken(accountRequests, tokenIn)
          + reservedCreationToken(creationWorkflows, tokenIn)
          + reservedLiquidityTokenAmount(liquidityOperations, tokenIn);
        const initialPoolReserved = requiredAllowanceFor({
          requests: accountRequests,
          liquidityOperations,
          creationWorkflows,
        }, tokenIn, toHex0x(config.handlerAddress));
        const initialQuote = deriveSwapQuote(
          initialSnapshot,
          direction,
          amount,
          slippageResult.basisPoints,
          initialReserved,
          initialPoolReserved,
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
                transactionHash:
                  approval.hash ?? approvalRequest.transactionHash,
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
              dispatchWriteFailure(dispatch, approval, "approval");
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
        const submissionAccountRequests = loadAccountRequestRecords(config);
        const submissionCreationWorkflows = loadAccountCreationWorkflows(config);
        const submissionLiquidityOperations = loadAccountLiquidityOperations(config);
        const submissionSnapshot = await readSnapshot();
        const submissionTokens = tokensForDirection(submissionSnapshot, direction);
        const submissionTokenIn = toHex0x(submissionTokens.input.address);
        const submissionReserved = reservedInputForToken(
          submissionAccountRequests,
          submissionTokenIn,
        ) + reservedCreationToken(
          submissionCreationWorkflows,
          submissionTokenIn,
        ) + reservedLiquidityTokenAmount(
          submissionLiquidityOperations,
          submissionTokenIn,
        );
        const submissionPoolReserved = requiredAllowanceFor({
          requests: submissionAccountRequests,
          liquidityOperations: submissionLiquidityOperations,
          creationWorkflows: submissionCreationWorkflows,
        }, submissionTokenIn, toHex0x(config.handlerAddress));
        const freshQuote = deriveSwapQuote(
          submissionSnapshot,
          direction,
          amount,
          slippageResult.basisPoints,
          submissionReserved,
          submissionPoolReserved,
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
          if (automaticProcessing && workspaceMounted.current) {
            setIsCranking(true);
            setCrankStorageError(null);
            try {
              await executeCrankWithLockHeld(expectedCrankAttempt);
            } catch {
              recoverInterruptedCrank();
            } finally {
              if (workspaceMounted.current) setIsCranking(false);
            }
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
            transactionHash:
              submission.hash ?? submittingRequest.transactionHash,
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
          dispatchWriteFailure(dispatch, submission, "submission");
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

  const applyCrankResult = (
    attempt: CrankAttempt,
    result: WriteResult,
  ): CrankAttempt => {
    if (result.kind === "committedSuccess") {
      const current = loadRequestCollection(config);
      const scanned = current.filter(isObservableRequest);
      let observations: RequestObservation[] = [];
      if (scanned.length > 0) {
        let batch;
        try {
          decodeRequestsProcessedSummary(result.receipt, config.driverAddress);
          const liquidity = loadLiquidityOperations(config);
          saveLiquidityOperations(
            config,
            applyLiquidityReceipt(config, liquidity, result.receipt),
          );
          for (const workflow of loadAccountCreationWorkflows(config)) {
            const observed = applyCreationReceipt(workflow, result.receipt);
            if (observed !== workflow) saveCreationWorkflow(config, observed);
          }
          batch = observationsFromReceipt(config, scanned, result.receipt);
        } catch {
          // Polling remains authoritative if a committed receipt cannot be decoded.
        }
        if (batch !== undefined) {
          const next = saveRequestCollection(
            config,
            applyObservationBatch(current, scanned, batch),
          );
          observations = batch.observations;
          if (workspaceMounted.current) {
            applyRequestCollection(next);
            if (observations.length > 0) {
              setExecutionOutcomes(observations);
              refreshSnapshot();
            }
          }
        }
      }
      return saveCrankAttempt(config, {
        ...attempt,
        status: "committed",
        transactionHash: result.hash,
        updatedAt: Date.now(),
        message: null,
      });
    }

    if (result.kind === "indeterminate") {
      return saveCrankAttempt(config, {
        ...attempt,
        status: "indeterminate",
        transactionHash: result.hash ?? attempt.transactionHash,
        updatedAt: Date.now(),
        message:
          "The queue-processing outcome is uncertain. Check the original transaction before trying again.",
      });
    }

    return saveCrankAttempt(config, {
      ...attempt,
      status: "failed",
      transactionHash: result.hash,
      updatedAt: Date.now(),
      message: crankFailureMessage(result),
    });
  };

  async function executeCrankWithLockHeld(
    expectedAttempt: CrankAttempt | null,
  ): Promise<void> {
    const current = loadRequestCollectionForUpdate(config);
    const accountRequests = loadAccountRequestRecords(config);
    const accountCrankAttempts = loadAccountCrankAttempts(config);
    const storedAttempt = loadCrankAttempt(config);
    if (!sameCrankAttempt(storedAttempt, expectedAttempt)) {
      if (workspaceMounted.current) {
        setRequests(current);
        setCrankAttempt(storedAttempt);
      }
      return;
    }
    if (
      accountCrankAttempts.some(isBlockingCrankAttempt)
      || accountRequests.some(isBlockingRequest)
      || hasBlockingAllowanceCleanup(config)
      || !current.some(needsQueueProcessing)
    ) return;

    let activeAttempt = saveCrankAttempt(config, createCrankAttempt(config));
    if (workspaceMounted.current) setCrankAttempt(activeAttempt);
    const result = await writeBoundary.execute(
      buildProcessRequestsTarget(config.driverAddress),
      {
        onSigned: (transactionHash) => {
          activeAttempt = saveCrankAttempt(config, {
            ...activeAttempt,
            transactionHash,
            updatedAt: Date.now(),
          });
          if (workspaceMounted.current) setCrankAttempt(activeAttempt);
        },
      },
    );
    activeAttempt = applyCrankResult(activeAttempt, result);
    if (workspaceMounted.current) setCrankAttempt(activeAttempt);
  }

  function recoverInterruptedCrank(): void {
    try {
      const recoverable = loadCrankAttempt(config);
      if (recoverable !== null && isBlockingCrankAttempt(recoverable)) {
        const activeAttempt = saveCrankAttempt(config, {
          ...recoverable,
          status: "indeterminate",
          updatedAt: Date.now(),
          message:
            "Queue processing was interrupted. Confirm the original transaction outcome before trying again.",
        });
        if (workspaceMounted.current) setCrankAttempt(activeAttempt);
      } else {
        setCrankStorageError("Queue processing could not be started safely.");
      }
    } catch {
      setCrankStorageError(
        "The queue-processing outcome is uncertain and its recovery state could not be saved.",
      );
    }
  }

  async function executeCrank() {
    if (
      !workspaceMounted.current
      || actionInFlight.current
      || crankStorageError !== null
    ) return;

    const expectedAttempt = crankAttempt;
    actionInFlight.current = true;
    setIsAcquiringLock(true);
    setIsCranking(true);
    setExecutionOutcomes([]);
    setCrankStorageError(null);
    try {
      await withRequestCollectionLock(config, () =>
        executeCrankWithLockHeld(expectedAttempt)
      );
    } catch {
      recoverInterruptedCrank();
    } finally {
      actionInFlight.current = false;
      if (workspaceMounted.current) {
        setIsAcquiringLock(false);
        setIsCranking(false);
      }
    }
  }

  async function checkCrankStatus() {
    const expectedAttempt = crankAttempt;
    if (
      expectedAttempt === null
      || expectedAttempt.transactionHash === null
      || writeBoundary.observe === undefined
      || actionInFlight.current
    ) return;

    actionInFlight.current = true;
    setIsAcquiringLock(true);
    setIsCranking(true);
    setExecutionOutcomes([]);
    setCrankStorageError(null);
    try {
      await withRequestCollectionLock(config, async () => {
        const storedAttempt = loadCrankAttempt(config);
        if (
          !sameCrankAttempt(storedAttempt, expectedAttempt)
          || storedAttempt === null
          || !isBlockingCrankAttempt(storedAttempt)
        ) {
          if (workspaceMounted.current) setCrankAttempt(storedAttempt);
          return;
        }
        const result = await writeBoundary.observe!(storedAttempt.transactionHash!);
        const nextAttempt = applyCrankResult(storedAttempt, result);
        if (workspaceMounted.current) {
          setCrankAttempt(nextAttempt);
          setCrankStorageError(null);
        }
      });
    } catch {
      setCrankStorageError(
        "The transaction status could not be checked. The original crank remains blocked.",
      );
    } finally {
      actionInFlight.current = false;
      if (workspaceMounted.current) {
        setIsAcquiringLock(false);
        setIsCranking(false);
      }
    }
  }

  function confirmPreHashCrankRecovery() {
    const expectedAttempt = crankAttempt;
    if (
      expectedAttempt === null
      || expectedAttempt.transactionHash !== null
      || actionInFlight.current
    ) return;
    void withRequestCollectionLock(config, () => {
      const storedAttempt = loadCrankAttempt(config);
      if (!sameCrankAttempt(storedAttempt, expectedAttempt)) return storedAttempt;
      return saveCrankAttempt(config, {
        ...storedAttempt!,
        status: "failed",
        updatedAt: Date.now(),
        message: "No queue-processing transaction was signed or submitted.",
      });
    }).then(setCrankAttempt).catch(() => {
      setCrankStorageError("Queue-processing recovery state could not be updated.");
    });
  }

  return (
    <div className="w-full">
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
        {crankStorageError !== null ? (
          <Alert variant="destructive">
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>Queue processing unavailable</AlertTitle>
            <AlertDescription>{crankStorageError}</AlertDescription>
          </Alert>
        ) : null}
        {accountSafety.error !== null ? (
          <Alert variant="destructive">
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>Account transaction state unavailable</AlertTitle>
            <AlertDescription>{accountSafety.error}</AlertDescription>
          </Alert>
        ) : null}
        {crossPoolRequestBlocked || crossPoolCrankBlocked
            || creationTransactionBlocked || liquidityTransactionBlocked ? (
          <Alert>
            <LockKeyholeIcon aria-hidden="true" />
            <AlertTitle>Another pool needs attention</AlertTitle>
            <AlertDescription>
              Resolve its pending transaction before signing from this account.
            </AlertDescription>
          </Alert>
        ) : null}
        <Card className="[--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)]">
          <CardHeader>
            <CardTitle asChild>
              <h2
                ref={headingRef}
                data-swap-workspace-heading
                tabIndex={-1}
                className="text-xl font-semibold tracking-tight focus:outline-none"
              >
                Swap preview
              </h2>
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
                className="relative mx-auto -my-5"
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
                !quoteValid
                || isUserRefreshing
                || controlsLocked
                || requestQueueFull
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
                allowanceDifference: quote.ok
                  ? quote.allowanceDifference
                  : null,
                workflow,
                outstanding: formOutstanding,
                isAcquiringLock,
                requestQueueFull,
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
        <Field
          orientation="horizontal"
          data-disabled={modeLocked}
          className="px-1"
        >
          <FieldContent>
            <FieldTitle>Manual queue processing</FieldTitle>
            <FieldDescription>
              Review request history and choose when to process the queue.
            </FieldDescription>
          </FieldContent>
          <Switch
            aria-label="Manual queue processing"
            checked={manualProcessing}
            disabled={modeLocked}
            onCheckedChange={(manual) =>
              setProcessingMode(manual ? "manual" : "automatic")}
          />
        </Field>
        <RequestList
          automatic={!manualProcessing}
          modeChangeDisabled={modeLocked}
          requests={requests}
          tokenA={snapshot.tokenA}
          tokenB={snapshot.tokenB}
          recoveryRequestId={isRecoveryRecord ? outstanding?.localId ?? null : null}
          isCheckingRecovery={isCheckingRecovery}
          crankAttempt={crankAttempt}
          isCranking={isCranking}
          crankDisabled={crankStorageError !== null || modeLocked}
          crankRecoveryDisabled={crankRecoveryDisabled}
          onDismiss={dismissRequest}
          onCrank={() => void executeCrank()}
          onCheckCrank={() => void checkCrankStatus()}
          onConfirmCrankRecovery={confirmPreHashCrankRecovery}
          onCheckRecovery={() => setRecoveryCheck((current) => current + 1)}
          onConfirmRecovery={confirmPreHashRecovery}
          onResolveUntracked={resolveUntrackedRequest}
          onShowManual={() => setProcessingMode("manual")}
        />
        <AllowanceCleanupCard
          config={config}
          snapshot={snapshot}
          readSnapshot={readSnapshot}
          writer={writeBoundary}
          onRefresh={refreshSnapshot}
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
      className="gap-3 rounded-lg border bg-muted p-4 has-focus-within:border-ring has-focus-within:ring-1 has-focus-within:ring-ring"
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
      <div className="flex min-w-0 flex-col items-start gap-3 min-[400px]:flex-row min-[400px]:items-center">
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
    <div className="flex flex-col gap-3 rounded-lg border bg-muted p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs text-muted-foreground">YOU RECEIVE</p>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          Balance {formatTokenAmount(token.balance, token.decimals, 6)}
        </p>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-3 min-[400px]:flex-row min-[400px]:items-center">
        <output
          aria-label="Estimated output"
          aria-live="polite"
          className="w-full min-w-0 flex-1 font-mono text-3xl font-medium tracking-tight break-all tabular-nums sm:text-4xl"
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
            <BlockchainIdentifier
              kind="address"
              value={toHex0x(config.handlerAddress)}
              label="Handler address"
            />
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
  allowanceDifference: bigint | null;
  workflow: WorkflowState;
  outstanding: RequestRecord | null;
  isAcquiringLock: boolean;
  requestQueueFull: boolean;
}): string {
  if (params.isAcquiringLock) {
    return params.allowanceDifference === 0n
      ? "Submitting swap"
      : "Approving swap";
  }
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
  if (params.workflow.status === "indeterminate") return "Outcome is uncertain";
  if (params.workflow.status === "error")
    return params.workflow.retryAllowed ? "Try again" : "Transaction failed";
  if (params.outstanding !== null) {
    if (params.outstanding.status === "queued") return "Queued for execution";
    return "Outstanding request recorded";
  }
  if (params.requestQueueFull) return "Swap queue is full";
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
  crankAttempt: CrankAttempt | null;
  isCranking: boolean;
  isAcquiringLock: boolean;
  allowanceDifference: bigint | null;
}): string {
  if (params.isCranking) return "Processing transaction queue.";
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
  if (activeWorkflow) {
    switch (params.workflow.status) {
      case "approving":
        return "Approving swap.";
      case "submitting":
        return "Submitting swap.";
      case "queued":
        return "Swap queued for execution.";
      default:
        return "";
    }
  }
  if (params.crankAttempt?.status === "indeterminate")
    return "Queue-processing outcome uncertain. Check the original transaction before trying again.";
  if (params.crankAttempt?.status === "failed")
    return "Queue processing failed. Retry without resubmitting the swap.";
  const status = params.outstanding?.status;
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
    handlerAddress: toHex0x(config.handlerAddress),
    driverAddress: toHex0x(config.driverAddress),
    sender: toHex0x(config.accountAddress),
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

function readInitialCrankState(config: AppConfig): {
  attempt: CrankAttempt | null;
  error: string | null;
} {
  try {
    return { attempt: loadCrankAttempt(config), error: null };
  } catch {
    return {
      attempt: null,
      error:
        "Stored queue-processing state could not be loaded safely. Clear this site's local data before cranking again.",
    };
  }
}

function readAccountSafetyState(config: AppConfig): {
  requests: RequestRecord[];
  crankAttempts: CrankAttempt[];
  creationWorkflows: CreationWorkflow[];
  liquidityOperations: LiquidityOperation[];
  allowanceCleanupBlocked: boolean;
  error: string | null;
} {
  try {
    return {
      requests: loadAccountRequestRecords(config),
      crankAttempts: loadAccountCrankAttempts(config),
      creationWorkflows: loadAccountCreationWorkflows(config),
      liquidityOperations: loadAccountLiquidityOperations(config),
      allowanceCleanupBlocked: hasBlockingAllowanceCleanup(config),
      error: null,
    };
  } catch {
    return {
      requests: [],
      crankAttempts: [],
      creationWorkflows: [],
      liquidityOperations: [],
      allowanceCleanupBlocked: false,
      error:
        "Stored account transaction state could not be loaded safely. Clear this site's local data before signing another transaction.",
    };
  }
}

function sameCrankAttempt(
  current: CrankAttempt | null,
  expected: CrankAttempt | null,
): boolean {
  if (current === null || expected === null) return current === expected;
  return current.id === expected.id
    && current.status === expected.status
    && current.transactionHash === expected.transactionHash
    && current.updatedAt === expected.updatedAt;
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

function requestMatchesObservation(
  request: RequestRecord,
  observation: RequestObservation,
): boolean {
  if (request.requestId !== observation.requestId) return false;
  if (observation.kind === "executionFailed") {
    return request.status === "failed"
      && request.execution?.kind === "failed"
      && request.execution.transactionHash === observation.transactionHash
      && request.execution.blockHeight === observation.blockHeight;
  }
  return request.status === "executed"
    && request.execution?.kind === "executed"
    && request.execution.transactionHash === observation.transactionHash
    && request.execution.blockHeight === observation.blockHeight
    && request.execution.amountIn === observation.amountIn
    && request.execution.amountOut === observation.amountOut;
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
        RequestAccepted.singleFromReceipt(result.receipt, {
          contractAddress: config.driverAddress,
        }).topics.request_id,
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
  phase: "approval" | "submission",
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
      message: swapFailureMessage(phase, result.receipt)
        ?? "The transaction committed without a successful execution result.",
    });
  }
}

function crankFailureMessage(
  result: Exclude<WriteResult, { kind: "committedSuccess" | "indeterminate" }>,
): string {
  if (result.kind === "preSubmissionFailure") return result.message;
  if (result.kind === "invalid") return result.reason;
  return swapFailureMessage("crank", result.receipt)
    ?? "The queue-processing transaction committed without a successful execution result.";
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
      const target = loadRequiredAllowance(
        config,
        tokenIn,
        toHex0x(config.handlerAddress),
      ) + amountIn;
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
