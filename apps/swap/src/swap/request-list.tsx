import { AlertCircleIcon, ArrowRightIcon, InfoIcon, XIcon } from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatTokenAmount } from "@/swap/model";
import type { TokenSnapshot } from "@/swap/snapshot";
import {
  isTerminalRequest,
  needsQueueProcessing,
  type RequestRecord,
  type RequestStatus,
} from "@/transactions/request-collection";
import {
  isBlockingCrankAttempt,
  type CrankAttempt,
} from "@/transactions/crank-attempt";

export function RequestList({
  automatic,
  modeChangeDisabled,
  requests,
  tokenA,
  tokenB,
  recoveryRequestId,
  isCheckingRecovery,
  crankAttempt,
  isCranking,
  crankDisabled,
  crankRecoveryDisabled,
  onDismiss,
  onCrank,
  onCheckCrank,
  onConfirmCrankRecovery,
  onCheckRecovery,
  onConfirmRecovery,
  onResolveUntracked,
  onShowManual,
  className,
}: {
  automatic: boolean;
  modeChangeDisabled: boolean;
  requests: readonly RequestRecord[];
  tokenA: TokenSnapshot;
  tokenB: TokenSnapshot;
  recoveryRequestId: string | null;
  isCheckingRecovery: boolean;
  crankAttempt: CrankAttempt | null;
  isCranking: boolean;
  crankDisabled: boolean;
  crankRecoveryDisabled: boolean;
  onDismiss: (localId: string) => void;
  onCrank: () => void;
  onCheckCrank: () => void;
  onConfirmCrankRecovery: () => void;
  onCheckRecovery: () => void;
  onConfirmRecovery: (localId: string) => void;
  onResolveUntracked: (localId: string) => void;
  onShowManual: () => void;
  className?: string;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterDismiss = useRef(false);
  useEffect(() => {
    if (!focusAfterDismiss.current) return;
    focusAfterDismiss.current = false;
    const target =
      headingRef.current ?? document.querySelector<HTMLHeadingElement>("h1");
    target?.focus();
  }, [requests.length]);
  const crankBlocked = isBlockingCrankAttempt(crankAttempt);
  if (requests.length === 0 && !crankBlocked) return null;

  const ordered = [...requests].sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      right.localId.localeCompare(left.localId),
  );
  const needsCrank = requests.some(needsQueueProcessing);
  const recoveryRequest = recoveryRequestId === null
    ? null
    : ordered.find(({ localId }) => localId === recoveryRequestId) ?? null;
  const compactRequest = recoveryRequest ?? ordered[0] ?? null;
  const visibleRequests = automatic
    ? compactRequest === null ? [] : [compactRequest]
    : ordered;
  const latestRequest = visibleRequests[0] ?? null;
  const hiddenQueuedWork = automatic && requests.some((request) =>
    request.localId !== latestRequest?.localId && needsQueueProcessing(request)
  );
  const showCrankControls = crankBlocked
    || (!automatic && needsCrank)
    || (automatic && crankAttempt?.status === "failed" && needsCrank);

  return (
    <Card className={cn("[--card-spacing:--spacing(4)]", className)}>
      <CardHeader>
        <CardTitle asChild>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold tracking-tight focus:outline-none"
          >
            {automatic ? "Latest swap" : "Requests"}
          </h2>
        </CardTitle>
        <CardDescription>
          {automatic
            ? "Current status for the latest swap."
            : "Local history for this account and pool. Quotes remain estimates until execution."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showCrankControls ? (
          <Alert role="region" aria-label="Transaction queue">
            <InfoIcon aria-hidden="true" />
            <AlertTitle>Transaction queue</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3 [&_p:not(:last-child)]:mb-0">
              <p>{crankDescription(crankAttempt, automatic)}</p>
              {crankBlocked ? (
                isCranking ? (
                  <p className="flex items-center gap-2 text-foreground">
                    <Spinner aria-hidden="true" />
                    Processing queue
                  </p>
                ) : crankAttempt?.transactionHash !== null ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-12 w-full whitespace-normal text-center sm:min-h-9 sm:w-auto"
                    disabled={crankRecoveryDisabled}
                    onClick={onCheckCrank}
                  >
                    Check crank status
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-12 w-full whitespace-normal text-center sm:min-h-9 sm:w-auto"
                    disabled={crankRecoveryDisabled}
                    onClick={onConfirmCrankRecovery}
                  >
                    I confirmed no crank transaction was signed
                  </Button>
                )
              ) : automatic ? (
                <Button
                  type="button"
                  size="sm"
                  className="min-h-12 w-full sm:min-h-9 sm:w-auto"
                  disabled={crankDisabled}
                  onClick={onCrank}
                >
                  Retry queue processing
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="min-h-12 w-full sm:min-h-9 sm:w-auto"
                  disabled={crankDisabled}
                  onClick={onCrank}
                >
                  Crank queue
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        <ol
          aria-label="Swap requests"
          className="divide-y divide-foreground/10"
        >
          {visibleRequests.map((request) => {
            const { input, output } = requestTokens(request, tokenA, tokenB);
            const confirming = confirmingId === request.localId;
            const recovering = recoveryRequestId === request.localId;
            return (
              <li key={request.localId} className="py-4 first:pt-1 last:pb-1">
                <article aria-labelledby={`${request.localId}-direction`}>
                  <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
                    <div className="min-w-0">
                      <h3
                        id={`${request.localId}-direction`}
                        className="flex min-w-0 items-center gap-2 font-medium"
                      >
                        <span className="truncate">{input.symbol}</span>
                        <ArrowRightIcon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate">{output.symbol}</span>
                      </h3>
                      <p className="mt-1 text-base text-muted-foreground tabular-nums sm:text-sm">
                        {formatTokenAmount(
                          request.intent.amountIn,
                          input.decimals,
                          8,
                        )}{" "}
                        {input.symbol} input
                        <span aria-hidden="true"> / </span>
                        <span className="sr-only">; </span>
                        minimum{" "}
                        {formatTokenAmount(
                          request.intent.amountOutMin,
                          output.decimals,
                          8,
                        )}{" "}
                        {output.symbol}
                      </p>
                    </div>
                    <RequestStatusBadge
                      status={request.status}
                      compact={automatic}
                    />
                  </div>

                  {request.execution?.kind === "executed" ? (
                    <p className="mt-2 text-base font-medium tabular-nums sm:text-sm">
                      {formatTokenAmount(
                        request.execution.amountIn,
                        input.decimals,
                        8,
                      )}{" "}
                      {input.symbol} was exchanged for{" "}
                      {formatTokenAmount(
                        request.execution.amountOut,
                        output.decimals,
                        8,
                      )}{" "}
                      {output.symbol}.
                    </p>
                  ) : null}

                  <RequestStatusDetail
                    request={request}
                    showHashes={!automatic}
                  />

                  {recovering &&
                  request.transactionHash !== null &&
                  ["approving", "submitting", "indeterminate"].includes(
                    request.status,
                  ) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 h-auto min-h-12 w-full whitespace-normal text-center sm:min-h-9 sm:w-auto"
                      disabled={isCheckingRecovery}
                      onClick={onCheckRecovery}
                    >
                      {isCheckingRecovery
                        ? "Checking transaction"
                        : "Check transaction status"}
                    </Button>
                  ) : null}

                  {recovering &&
                  request.transactionHash === null &&
                  ["approving", "submitting", "indeterminate"].includes(
                    request.status,
                  ) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 h-auto min-h-12 w-full whitespace-normal text-center sm:min-h-9 sm:w-auto"
                      onClick={() => onConfirmRecovery(request.localId)}
                    >
                      I confirmed no transaction is pending or queued
                    </Button>
                  ) : null}

                  {!automatic && isTerminalRequest(request) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="relative mt-2 min-h-12 sm:min-h-9"
                      onClick={() => {
                        focusAfterDismiss.current = true;
                        onDismiss(request.localId);
                      }}
                    >
                      <XIcon data-icon="inline-start" aria-hidden="true" />
                      Dismiss from history
                    </Button>
                  ) : null}

                  {request.status === "queuedUntracked" && !confirming ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 min-h-12 sm:min-h-9"
                      onClick={() => setConfirmingId(request.localId)}
                    >
                      Resolve manually
                    </Button>
                  ) : null}

                  {request.status === "queuedUntracked" && confirming ? (
                    <Alert variant="destructive" className="mt-3">
                      <AlertCircleIcon aria-hidden="true" />
                      <AlertTitle>Confirm the queue is drained</AlertTitle>
                      <AlertDescription>
                        Only resolve this request after independently confirming
                        that queue processing drained the relevant queue. Its
                        request ID is unavailable, so execution cannot be
                        matched automatically.
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="min-h-12 sm:min-h-9"
                            onClick={() => {
                              setConfirmingId(null);
                              focusAfterDismiss.current = true;
                              onResolveUntracked(request.localId);
                            }}
                          >
                            Confirm queue is drained
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-12 sm:min-h-9"
                            onClick={() => setConfirmingId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
        {hiddenQueuedWork ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-12 w-full sm:min-h-9 sm:w-auto"
            disabled={modeChangeDisabled}
            onClick={onShowManual}
          >
            Queued work available
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function crankDescription(
  attempt: CrankAttempt | null,
  automatic: boolean,
): string {
  if (attempt?.status === "signing")
    return "Queue transaction awaiting outcome.";
  if (attempt?.status === "indeterminate") {
    return "The last crank's outcome is uncertain. Check it before trying again.";
  }
  if (attempt?.status === "failed")
    return automatic
      ? "Queue processing failed. Retry without resubmitting your swap."
      : "Queue processing failed. Try again.";
  return "Crank to process all requests in the queue.";
}

function RequestStatusBadge({
  status,
  compact,
}: {
  status: RequestStatus;
  compact: boolean;
}) {
  const destructive = status === "failed" || status === "committedFailure";
  const active = status === "approving" || status === "submitting";
  return (
    <Badge
      variant={destructive ? "destructive" : active ? "secondary" : "outline"}
      className="shrink-0"
    >
      {compact ? compactRequestStatusLabel(status) : requestStatusLabel(status)}
    </Badge>
  );
}

function RequestStatusDetail({
  request,
  showHashes,
}: {
  request: RequestRecord;
  showHashes: boolean;
}) {
  const detail = requestStatusDetail(request.status);
  const executionHash =
    request.execution?.transactionHash === request.transactionHash
      ? null
      : (request.execution?.transactionHash ?? null);
  if (
    detail === null &&
    (!showHashes || request.transactionHash === null) &&
    (!showHashes || executionHash === null)
  )
    return null;
  return (
    <div className="mt-2 space-y-1 text-base text-muted-foreground sm:text-sm">
      {detail === null ? null : <p>{detail}</p>}
      {!showHashes || request.transactionHash === null ? null : (
        <p className="text-xs sm:text-xs">
          {executionHash === null ? "Transaction" : "Enqueue transaction"}{" "}
          <BlockchainIdentifier
            value={request.transactionHash}
            label={
              executionHash === null
                ? "Transaction hash"
                : "Enqueue transaction hash"
            }
          />
        </p>
      )}
      {!showHashes || executionHash === null ? null : (
        <p className="text-xs sm:text-xs">
          Execution transaction{" "}
          <BlockchainIdentifier
            value={executionHash}
            label="Execution transaction hash"
          />
        </p>
      )}
    </div>
  );
}

function compactRequestStatusLabel(status: RequestStatus): string {
  switch (status) {
    case "approving":
      return "Approving";
    case "submitting":
      return "Submitting swap";
    case "indeterminate":
      return "Transaction outcome uncertain";
    case "committedFailure":
    case "failed":
      return "Swap failed";
    case "queued":
    case "queuedNotObserved":
    case "queuedUntracked":
      return "Execution pending";
    case "executed":
      return "Executed";
  }
}

function requestTokens(
  request: RequestRecord,
  tokenA: TokenSnapshot,
  tokenB: TokenSnapshot,
): { input: TokenSnapshot; output: TokenSnapshot } {
  return request.criteria.tokenIn === toHex0x(tokenA.address)
    ? { input: tokenA, output: tokenB }
    : { input: tokenB, output: tokenA };
}

function requestStatusLabel(status: RequestStatus): string {
  switch (status) {
    case "approving":
      return "Approving";
    case "submitting":
      return "Submitting";
    case "indeterminate":
      return "Outcome uncertain";
    case "committedFailure":
      return "Submission failed";
    case "queued":
      return "Queued for execution";
    case "queuedNotObserved":
      return "Execution not observed";
    case "queuedUntracked":
      return "Queued; request ID unavailable";
    case "executed":
      return "Executed";
    case "failed":
      return "Failed";
  }
}

function requestStatusDetail(status: RequestStatus): string | null {
  switch (status) {
    case "committedFailure":
      return "The submission committed with a failed execution result.";
    case "queuedNotObserved":
      return "No terminal event was found during two visible minutes. The request may still execute.";
    case "queuedUntracked":
      return "Accepted by the router, but its request ID could not be decoded.";
    default:
      return null;
  }
}
