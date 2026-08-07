import {
  AlertCircleIcon,
  ArrowDownUpIcon,
  ChevronDownIcon,
  InfoIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useEffect, useId, useReducer, useRef, useState } from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
import { formatAmount } from "@/domain/amount";
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
import type {
  PoolSnapshot,
  SnapshotReader,
  TokenSnapshot,
} from "@/swap/snapshot";
import { usePoolSnapshot } from "@/swap/use-pool-snapshot";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";
import {
  clearOutstandingRequest,
  loadOutstandingRequest,
  outstandingRequestKey,
  saveOutstandingRequest,
  withOutstandingRequestLock,
  type OutstandingRequest,
} from "@/transactions/outstanding-request";
import {
  initialWorkflowState,
  workflowReducer,
  type WorkflowState,
} from "@/workflow";

const SLIPPAGE_PRESETS = [10n, 50n, 100n] as const;

export function SwapPage({
  config,
  readSnapshot,
  writeBoundary,
}: {
  config: AppConfig;
  readSnapshot: SnapshotReader;
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
          <EnvironmentWarning
            localRpc={isLoopbackUrl(config.rpcUrl) && isBrowserLoopback()}
          />
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
              {" "}/ local terminal
            </div>
          </div>
        </a>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="hidden font-mono sm:inline-flex">
            <span
              aria-hidden="true"
              className={connected ? "size-1.5 rounded-full bg-local" : "size-1.5 rounded-full bg-muted-foreground"}
            />
            {connected && chainHeight !== null
              ? `${localRpc ? "RPC" : "REMOTE"} · block ${chainHeight}`
              : "Connecting"}
          </Badge>
          <Badge variant="secondary" className="hidden font-mono md:inline-flex">
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
              className={connected ? "size-1.5 rounded-full bg-local" : "size-1.5 rounded-full bg-muted-foreground"}
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

function EnvironmentWarning({ localRpc }: { localRpc: boolean }) {
  return (
    <Alert className="bg-local/8 text-foreground ring-local/20">
      <InfoIcon aria-hidden="true" />
      <AlertTitle>{localRpc ? "Disposable local signer" : "Read-only preview"}</AlertTitle>
      <AlertDescription>
        {localRpc
          ? "This browser contains a generated development key. Use it only with this disposable loopback ledger; never fund it on a public network."
          : "Quotes use configured-pool reads. Signing is blocked because the RPC is not loopback."}
      </AlertDescription>
    </Alert>
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
  refreshSnapshot: () => void;
  writeBoundary: WriteBoundary;
}) {
  const [direction, setDirection] = useState<SwapDirection>("aToB");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [workflow, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [outstanding, setOutstanding] = useState<OutstandingRequest | null>(
    () => loadOutstandingRequest(config),
  );
  const [isRecoveryRecord, setIsRecoveryRecord] = useState(
    () => loadOutstandingRequest(config) !== null,
  );
  const [isAcquiringLock, setIsAcquiringLock] = useState(false);
  const [recoveryCheck, setRecoveryCheck] = useState(0);
  const [isCheckingRecovery, setIsCheckingRecovery] = useState(false);
  const recoveryAttempt = useRef<string | null>(null);
  const actionInFlight = useRef(false);
  const amountId = useId();
  const slippageId = useId();
  const tokens = tokensForDirection(snapshot, direction);
  const slippageResult = parseSlippagePercent(slippage);
  const quote = deriveSwapQuote(
    snapshot,
    direction,
    amount,
    slippageResult.ok ? slippageResult.basisPoints : 50n,
  );
  const hasLiquidity = snapshot.reserve0 > 0n && snapshot.reserve1 > 0n;
  const quoteValid = quote.ok && slippageResult.ok;
  const controlsLocked =
    isAcquiringLock || isWorkflowLocked(workflow) || outstanding !== null;
  const localRpc = isLoopbackUrl(config.rpcUrl) && isBrowserLoopback();

  const output = quote.ok
    ? formatTokenAmount(quote.amountOut, tokens.output.decimals, 8)
    : "—";
  const validationMessage =
    amount.length === 0 || quote.ok ? null : quoteErrorMessages[quote.error];

  useEffect(() => {
    const key = outstandingRequestKey(config);
    const reload = (event: StorageEvent) => {
      if (event.key === key) {
        setOutstanding(loadOutstandingRequest(config));
        setIsRecoveryRecord(!actionInFlight.current);
      }
    };
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [config]);

  useEffect(() => {
    if (
      !isRecoveryRecord
      || outstanding?.transactionHash === null
      || outstanding === null
      || writeBoundary.observe === undefined
      || !["approving", "submitting", "indeterminate"].includes(
        outstanding.status,
      )
    ) return;

    const attemptKey = `${outstanding.transactionHash}:${recoveryCheck}`;
    if (recoveryAttempt.current === attemptKey) return;
    recoveryAttempt.current = attemptKey;

    let cancelled = false;
    setIsCheckingRecovery(true);
    void writeBoundary.observe(outstanding.transactionHash).then(
      async (result) => {
        if (cancelled) return;
        if (result.kind === "committedSuccess") {
          if (outstanding.phase === "swap") {
            const queuedRequest: OutstandingRequest = {
              ...outstanding,
              status: "queued",
              transactionHash: result.hash,
              receiptBlock: result.receipt.height,
            };
            saveOutstandingRequest(config, queuedRequest);
            setOutstanding(queuedRequest);
            return;
          }

          try {
            const snapshot = await readSnapshot();
            const inputToken = outstanding.criteria.tokenIn
              === toHex0x(snapshot.tokenA.address)
              ? snapshot.tokenA
              : outstanding.criteria.tokenIn === toHex0x(snapshot.tokenB.address)
                ? snapshot.tokenB
                : null;
            if (
              !cancelled
              && snapshot.chainHeight >= result.receipt.height
              && inputToken?.allowance === outstanding.intent.amountIn
            ) {
              clearOutstandingRequest(config);
              setOutstanding(null);
              setIsRecoveryRecord(false);
              refreshSnapshot();
              return;
            }
          } catch {
            // Keep the signed recovery record for another explicit status check.
          }
        }

        if (result.kind === "invalid" || result.kind === "preSubmissionFailure") {
          clearOutstandingRequest(config);
          setOutstanding(null);
          setIsRecoveryRecord(false);
        } else if (result.kind === "committedFailure") {
          const failedRequest: OutstandingRequest = {
            ...outstanding,
            status: "committedFailure",
            transactionHash: result.hash,
          };
          saveOutstandingRequest(config, failedRequest);
          setOutstanding(failedRequest);
        } else {
          const uncertainRequest: OutstandingRequest = {
            ...outstanding,
            status: "indeterminate",
            transactionHash: result.hash,
          };
          saveOutstandingRequest(config, uncertainRequest);
          setOutstanding(uncertainRequest);
        }
      },
      () => {
        // A failed recovery read is non-authoritative; preserve the signed record.
      },
    ).finally(() => {
      if (!cancelled) setIsCheckingRecovery(false);
    });
    return () => {
      cancelled = true;
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

  function switchDirection() {
    if (actionInFlight.current) return;
    dispatch({ type: "inputChanged" });
    setDirection((current) => (current === "aToB" ? "bToA" : "aToB"));
    setAmount("");
  }

  function changeAmount(value: string) {
    if (actionInFlight.current) return;
    dispatch({ type: "inputChanged" });
    setAmount(value);
  }

  function changeSlippage(value: string) {
    if (actionInFlight.current) return;
    dispatch({ type: "inputChanged" });
    setSlippage(value);
  }

  async function executeAction(insideLock = false) {
    if (
      !quote.ok
      || !slippageResult.ok
      || (!insideLock && actionInFlight.current)
      || !localRpc
    ) return;
    const intent = { amountIn: quote.amountIn, amountOutMin: quote.amountOutMin };
    const needsApproval =
      workflow.status !== "readyToSwap" && quote.allowanceDifference !== 0n;

    if (!insideLock) {
      actionInFlight.current = true;
      setIsAcquiringLock(true);
      try {
        await withOutstandingRequestLock(config, async () => {
          const existing = loadOutstandingRequest(config);
          if (existing !== null) {
            setOutstanding(existing);
            setIsRecoveryRecord(true);
            return;
          }
          setIsAcquiringLock(false);
          await executeAction(true);
        });
      } catch (error) {
        dispatch({ type: "inputChanged" });
        dispatch(needsApproval
          ? { type: "approvalRequired", intent }
          : { type: "quoteReady", intent });
        dispatch({ type: needsApproval ? "approvalStarted" : "submissionStarted" });
        dispatch({
          type: "transactionFailed",
          certainty: "notSubmitted",
          transactionHash: null,
          message: error instanceof Error ? error.message : "The submission lock could not be acquired.",
        });
      } finally {
        actionInFlight.current = false;
        setIsAcquiringLock(false);
      }
      return;
    }

    let outstandingStarted = false;
    let outstandingIntent = intent;
    let outstandingHash: string | null = null;
    let outstandingPhase: OutstandingRequest["phase"] = needsApproval
      ? "approval"
      : "swap";

    dispatch({ type: "inputChanged" });
    dispatch(needsApproval ? { type: "approvalRequired", intent } : { type: "quoteReady", intent });
    dispatch({ type: needsApproval ? "approvalStarted" : "submissionStarted" });

    try {
      if (needsApproval) {
        let freshApprovalQuote;
        try {
          freshApprovalQuote = deriveSwapQuote(
            await readSnapshot(),
            direction,
            amount,
            slippageResult.basisPoints,
          );
          if (!freshApprovalQuote.ok) {
            dispatch({
              type: "transactionFailed",
              certainty: "notSubmitted",
              transactionHash: null,
              message: "The quote changed before approval. Refresh and review it again.",
            });
            return;
          }
          if (freshApprovalQuote.allowanceDifference === 0n) {
            dispatch({ type: "approvalObserved" });
            dispatch({ type: "submissionStarted" });
          }
        } catch {
          dispatch({
            type: "transactionFailed",
            certainty: "notSubmitted",
            transactionHash: null,
            message: "A fresh pre-approval snapshot could not be loaded.",
          });
          return;
        }

        if (freshApprovalQuote.allowanceDifference !== 0n) {
          const approvalRequest: OutstandingRequest = {
            status: "approving",
            phase: "approval",
            intent: {
              amountIn: freshApprovalQuote.amountIn,
              amountOutMin: freshApprovalQuote.amountOutMin,
            },
            transactionHash: null,
            receiptBlock: null,
            criteria: requestCriteria(config, tokens),
          };
          saveOutstandingRequest(config, approvalRequest);
          setOutstanding(approvalRequest);
          setIsRecoveryRecord(false);
          outstandingStarted = true;
          outstandingIntent = approvalRequest.intent;
          outstandingPhase = "approval";
          const result = await writeBoundary.execute(
            buildApprovalTarget(
              tokens.input.address,
              config.handlerAddress,
              freshApprovalQuote.allowanceDifference,
            ),
            {
              onSigned: (hash) => {
                outstandingHash = hash;
                const signedRequest = {
                  ...approvalRequest,
                  transactionHash: hash,
                };
                saveOutstandingRequest(config, signedRequest);
                setOutstanding(signedRequest);
              },
            },
          );
          if (result.kind !== "committedSuccess") {
            if (
              result.kind === "indeterminate"
              || result.kind === "committedFailure"
            ) {
              const unresolved: OutstandingRequest = {
                ...approvalRequest,
                status: result.kind === "indeterminate"
                  ? "indeterminate"
                  : "committedFailure",
                transactionHash: result.hash,
              };
              saveOutstandingRequest(config, unresolved);
              setOutstanding(unresolved);
            } else {
              clearOutstandingRequest(config);
              setOutstanding(null);
              setIsRecoveryRecord(false);
            }
            dispatchWriteFailure(dispatch, result);
            return;
          }

          if (
            !(await observeExactAllowance(
              readSnapshot,
              direction,
              freshApprovalQuote.amountIn,
              result.receipt.height,
            ))
          ) {
            const unresolved: OutstandingRequest = {
              ...approvalRequest,
              status: "indeterminate",
              transactionHash: result.hash,
            };
            saveOutstandingRequest(config, unresolved);
            setOutstanding(unresolved);
            dispatch({ type: "transactionIndeterminate", transactionHash: result.hash });
            return;
          }
          dispatch({ type: "approvalObserved" });
          dispatch({ type: "submissionStarted" });
          refreshSnapshot();
        }
      }

      let freshQuote;
      try {
        const freshSnapshot = await readSnapshot();
        freshQuote = deriveSwapQuote(
          freshSnapshot,
          direction,
          amount,
          slippageResult.basisPoints,
        );
        const freshInput = tokensForDirection(freshSnapshot, direction).input;
        if (
          !freshQuote.ok
          || freshInput.allowance !== freshQuote.amountIn
          || freshQuote.amountOut < intent.amountOutMin
        ) {
          if (outstandingPhase === "approval") {
            clearOutstandingRequest(config);
            setOutstanding(null);
            setIsRecoveryRecord(false);
          }
          dispatch({
            type: "transactionFailed",
            certainty: "notSubmitted",
            transactionHash: null,
            message: "The allowance changed or the quote moved beyond your reviewed slippage limit. Refresh and review it again.",
          });
          return;
        }
      } catch {
        if (outstandingPhase === "approval") {
          clearOutstandingRequest(config);
          setOutstanding(null);
          setIsRecoveryRecord(false);
        }
        dispatch({
          type: "transactionFailed",
          certainty: "notSubmitted",
          transactionHash: null,
          message: "A fresh pre-submission snapshot could not be loaded.",
        });
        return;
      }

      dispatch({
        type: "submissionRefreshed",
        intent: {
          amountIn: freshQuote.amountIn,
          amountOutMin: intent.amountOutMin,
        },
      });
      const submittedIntent = {
        amountIn: freshQuote.amountIn,
        amountOutMin: intent.amountOutMin,
      };
      outstandingIntent = submittedIntent;
      const submittingRequest: OutstandingRequest = {
        status: "submitting",
        phase: "swap",
        intent: submittedIntent,
        transactionHash: null,
        receiptBlock: null,
        criteria: requestCriteria(config, tokens),
      };
      outstandingPhase = "swap";
      saveOutstandingRequest(config, submittingRequest);
      setOutstanding(submittingRequest);
      setIsRecoveryRecord(false);
      outstandingStarted = true;
      const result = await writeBoundary.execute(
        buildExactInputSwapTarget(config.routerAddress, {
          amountIn: freshQuote.amountIn,
          amountOutMin: intent.amountOutMin,
          tokenIn: tokens.input.address,
          tokenOut: tokens.output.address,
          recipient: config.accountAddress,
        }),
        {
          onSigned: (hash) => {
            outstandingHash = hash;
            const signedRequest = {
              ...submittingRequest,
              transactionHash: hash,
            };
            saveOutstandingRequest(config, signedRequest);
            setOutstanding(signedRequest);
          },
        },
      );
      if (result.kind === "committedSuccess") {
        const queuedRequest: OutstandingRequest = {
          status: "queued",
          phase: "swap",
          intent: submittedIntent,
          transactionHash: result.hash,
          receiptBlock: result.receipt.height,
          criteria: submittingRequest.criteria,
        };
        saveOutstandingRequest(config, queuedRequest);
        setOutstanding(queuedRequest);
        dispatch({
          type: "requestQueued",
          transactionHash: result.hash,
          receiptBlock: result.receipt.height,
        });
      } else {
        if (result.kind === "indeterminate") {
          const uncertainRequest: OutstandingRequest = {
            status: "indeterminate",
            phase: "swap",
            intent: submittedIntent,
            transactionHash: result.hash,
            receiptBlock: null,
            criteria: submittingRequest.criteria,
          };
          saveOutstandingRequest(config, uncertainRequest);
          setOutstanding(uncertainRequest);
        } else if (result.kind === "committedFailure") {
          const failedRequest: OutstandingRequest = {
            ...submittingRequest,
            status: "committedFailure",
            transactionHash: result.hash,
          };
          saveOutstandingRequest(config, failedRequest);
          setOutstanding(failedRequest);
        } else {
          clearOutstandingRequest(config);
          setOutstanding(null);
          setIsRecoveryRecord(false);
        }
        dispatchWriteFailure(dispatch, result);
      }
    } catch {
      if (outstandingStarted) {
        const uncertainRequest: OutstandingRequest = {
          status: "indeterminate",
          phase: outstandingPhase,
          intent: outstandingIntent,
          transactionHash: outstandingHash,
          receiptBlock: null,
          criteria: requestCriteria(config, tokens),
        };
        saveOutstandingRequest(config, uncertainRequest);
        setOutstanding(uncertainRequest);
      }
      dispatch({
        type: "transactionIndeterminate",
        transactionHash: outstandingHash,
      });
    }
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]">
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
                    formatAmount(tokens.input.balance, tokens.input.decimals),
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
              disabled={!localRpc || !quoteValid || isUserRefreshing || controlsLocked}
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
                allowanceDifference: quote.ok ? quote.allowanceDifference : null,
                workflow,
                outstanding,
                isAcquiringLock,
              })}
            </Button>
            <WorkflowStatus
              workflow={workflow}
              outstanding={outstanding}
              isRecoveryRecord={isRecoveryRecord}
              isCheckingRecovery={isCheckingRecovery}
              onCheckRecovery={() => setRecoveryCheck((current) => current + 1)}
              onConfirmCrank={() => {
                clearOutstandingRequest(config);
                setOutstanding(null);
                setIsRecoveryRecord(false);
                if (workflow.status === "queued" || workflow.status === "queuedNotObserved") {
                  dispatch({ type: "confirmExternalCrank" });
                } else if (
                  workflow.status === "error"
                  && workflow.certainty === "committed"
                ) {
                  dispatch({ type: "acknowledgeCommittedFailure" });
                }
              }}
            />
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            <TransactionDetails
              config={config}
              quote={quote.ok ? quote : null}
              input={tokens.input}
              output={tokens.output}
              slippageValid={slippageResult.ok}
            />
            <p className="text-pretty text-base text-muted-foreground sm:text-sm">
              Your displayed estimate may change because execution uses live
              reserves. Minimum output is enforced, but a queued request can
              still fail during external processing and be consumed.
            </p>
          </CardFooter>
        </Card>
      </div>
      <PoolTelemetry config={config} snapshot={snapshot} />
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
    <Field data-invalid={error !== null} className="gap-3 rounded-xl bg-muted/60 p-4 ring-1 ring-foreground/8 has-focus-within:ring-2 has-focus-within:ring-ring">
      <div className="flex items-center justify-between gap-3">
        <FieldLabel htmlFor={id} className="font-mono text-xs text-muted-foreground">
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
    <Badge variant="outline" className="h-9 shrink-0 bg-card px-2.5 font-mono text-sm">
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
    ? SLIPPAGE_PRESETS.find((preset) => preset === result.basisPoints)?.toString()
    : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} className="relative font-mono">
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
            <FieldError id={`${id}-error`}>Enter more than 0% and no more than 50%, using at most two decimals.</FieldError>
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
        {quote === null ? "—" : `${formatTokenAmount(quote.amountOut, output.decimals, 8)} ${output.symbol}`}
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
        <Button type="button" variant="ghost" className="group min-h-12 w-full justify-between sm:min-h-9">
          Transaction details
          <ChevronDownIcon aria-hidden="true" className="group-data-open:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 font-mono text-base sm:text-sm">
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

function PoolTelemetry({
  config,
  snapshot,
}: {
  config: AppConfig;
  snapshot: PoolSnapshot;
}) {
  const inputIndex = orderTokens(
    snapshot.tokenA.address,
    snapshot.tokenB.address,
  ).inputIndex;
  const reserves = orientReserves(
    [snapshot.reserve0, snapshot.reserve1],
    inputIndex,
  );

  return (
    <Card size="sm" className="lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle asChild>
          <h2 className="font-mono text-xs tracking-wide text-muted-foreground">
            POOL TELEMETRY
          </h2>
        </CardTitle>
        <CardDescription>
          Advisory reads may span nearby committed heights.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-4">
          <TelemetryItem label={`${snapshot.tokenA.symbol} reserve`}>
            {formatTokenAmount(reserves.reserveIn, snapshot.tokenA.decimals, 4)}
          </TelemetryItem>
          <Separator />
          <TelemetryItem label={`${snapshot.tokenB.symbol} reserve`}>
            {formatTokenAmount(reserves.reserveOut, snapshot.tokenB.decimals, 4)}
          </TelemetryItem>
          <Separator />
          <TelemetryItem label="Configured network">
            {`0x${config.networkIdHex.slice(0, 8)}…`}
          </TelemetryItem>
          <Separator />
          <TelemetryItem label="Account">
            {abbreviateAddress(config.accountAddress)}
          </TelemetryItem>
          <Separator />
          <TelemetryItem label="RPC endpoint">
            {config.rpcUrl.host}
          </TelemetryItem>
        </dl>
      </CardContent>
    </Card>
  );
}

function TelemetryItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="truncate font-mono text-base text-muted-foreground tabular-nums sm:text-sm">
        {children}
      </dd>
    </div>
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
  outstanding: OutstandingRequest | null;
  isAcquiringLock: boolean;
}): string {
  if (params.isAcquiringLock) return "Waiting for submission lock";
  if (!params.localRpc) return "Signing requires a local RPC";
  if (params.workflow.status === "approving") return "Approval pending";
  if (params.workflow.status === "readyToSwap") return "Swap";
  if (params.workflow.status === "submitting") return "Submitting swap";
  if (params.workflow.status === "queued") return "Queued for execution";
  if (params.workflow.status === "queuedNotObserved") return "Queued; execution not observed";
  if (params.workflow.status === "indeterminate") return "Outcome is uncertain";
  if (params.workflow.status === "error") return params.workflow.retryAllowed ? "Try again" : "Transaction failed";
  if (params.outstanding !== null) {
    if (params.outstanding.status === "queued") return "Queued for execution";
    if (params.outstanding.status === "committedFailure") return "Transaction failed";
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
  return ["approving", "submitting", "indeterminate", "queued", "queuedNotObserved"].includes(workflow.status)
    || (workflow.status === "error" && !workflow.retryAllowed);
}

function WorkflowStatus({
  workflow,
  outstanding,
  isRecoveryRecord,
  isCheckingRecovery,
  onCheckRecovery,
  onConfirmCrank,
}: {
  workflow: WorkflowState;
  outstanding: OutstandingRequest | null;
  isRecoveryRecord: boolean;
  isCheckingRecovery: boolean;
  onCheckRecovery: () => void;
  onConfirmCrank: () => void;
}) {
  if (
    outstanding === null
    && ["idle", "quoting", "readyToApprove", "readyToSwap"].includes(workflow.status)
  ) return null;

  const hash = "transactionHash" in workflow
    ? workflow.transactionHash
    : outstanding?.transactionHash ?? null;
  const workflowIsLive = ![
    "idle",
    "quoting",
    "readyToApprove",
    "readyToSwap",
  ].includes(workflow.status);
  const status = outstanding?.status === "committedFailure"
    ? "committedFailure"
    : !isRecoveryRecord && workflowIsLive
      ? workflow.status
      : outstanding?.status ?? workflow.status;
  const canClearRecoveredPreHash =
    outstanding?.transactionHash === null
    && isRecoveryRecord
    && (status === "approving" || status === "submitting")
    && ["idle", "quoting", "readyToApprove", "readyToSwap"].includes(
      workflow.status,
    );
  const message = status === "queued"
    ? "The router accepted this request. Run bash scripts/crank-local.sh from apps/swap to process it; execution has not been observed yet."
    : status === "committedFailure"
      ? "The transaction committed with a failed execution result. No automatic retry will be attempted."
    : status === "approving"
      ? isRecoveryRecord
        ? "The approval started before this page was restored. Confirm its status before clearing this recovery guard."
        : "Waiting for the exact allowance transaction to commit."
    : status === "indeterminate" || status === "submitting"
      ? "The transaction may still commit. Do not submit another transaction."
      : workflow.status === "error"
        ? workflow.message
        : workflow.status === "approving"
          ? "Waiting for the exact allowance transaction to commit."
          : workflow.status === "submitting"
            ? "Waiting for the router to accept the swap request."
            : "The request remains queued and no execution event has been observed.";

  return (
    <Alert className="mt-4" variant={workflow.status === "error" ? "destructive" : "default"}>
      <InfoIcon aria-hidden="true" />
      <AlertTitle>
        {status === "submitting" && isRecoveryRecord
          ? "Submission recovery required"
          : actionLabelForStatus(status)}
      </AlertTitle>
      <AlertDescription>
        {message}
        {hash !== null ? <span className="mt-1 block break-all font-mono text-xs">Transaction {hash}</span> : null}
        {status === "queued" || status === "committedFailure" ? (
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onConfirmCrank}>
            {status === "queued"
              ? "I cranked and confirmed the queue is drained"
              : "Acknowledge committed failure"}
          </Button>
        ) : null}
        {canClearRecoveredPreHash ? (
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onConfirmCrank}>
            I confirmed no transaction is pending or queued
          </Button>
        ) : null}
        {isRecoveryRecord && hash !== null && ["approving", "submitting", "indeterminate"].includes(status) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={isCheckingRecovery}
            onClick={onCheckRecovery}
          >
            {isCheckingRecovery ? "Checking transaction" : "Check transaction status"}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function actionLabelForStatus(
  status: WorkflowState["status"] | OutstandingRequest["status"],
): string {
  switch (status) {
    case "approving": return "Approval pending";
    case "submitting": return "Submitting swap";
    case "queued": return "Queued for execution";
    case "queuedNotObserved": return "Execution not observed";
    case "indeterminate": return "Outcome uncertain";
    case "committedFailure": return "Committed failure";
    case "error": return "Transaction issue";
    case "executionObserved": return "Execution observed";
    default: return "Transaction status";
  }
}

function requestCriteria(
  config: AppConfig,
  tokens: { input: TokenSnapshot; output: TokenSnapshot },
): OutstandingRequest["criteria"] {
  return {
    pairAddress: toHex0x(config.pairAddress),
    handlerAddress: toHex0x(config.handlerAddress),
    recipient: toHex0x(config.accountAddress),
    tokenIn: toHex0x(tokens.input.address),
    tokenOut: toHex0x(tokens.output.address),
  };
}

function dispatchWriteFailure(
  dispatch: React.Dispatch<Parameters<typeof workflowReducer>[1]>,
  result: Exclude<WriteResult, { kind: "committedSuccess" }>,
): void {
  if (result.kind === "indeterminate") {
    dispatch({ type: "transactionIndeterminate", transactionHash: result.hash });
    return;
  }
  if (result.kind === "preSubmissionFailure") {
    dispatch({ type: "transactionFailed", certainty: "notSubmitted", transactionHash: null, message: result.message });
  } else if (result.kind === "invalid") {
    dispatch({ type: "transactionFailed", certainty: "invalid", transactionHash: result.hash, message: result.reason });
  } else {
    dispatch({ type: "transactionFailed", certainty: "committed", transactionHash: result.hash, message: "The transaction committed without a successful execution result." });
  }
}

async function observeExactAllowance(
  readSnapshot: SnapshotReader,
  direction: SwapDirection,
  amountIn: bigint,
  receiptBlock: bigint,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const snapshot = await readSnapshot();
      if (
        snapshot.chainHeight >= receiptBlock
        && tokensForDirection(snapshot, direction).input.allowance === amountIn
      ) {
        return true;
      }
    } catch {
      // Retry short-lived read failures while waiting for the committed allowance.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return false;
}
