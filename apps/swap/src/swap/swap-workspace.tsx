import { ArrowDownUpIcon, LockKeyholeIcon } from "lucide-react";
import { AllowanceCleanupCard } from "@/components/allowance-cleanup-card";
import { SlippageSettings } from "@/components/slippage-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldTitle,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { RequestList } from "./request-list";
import {
  TokenInputPanel,
  TokenOutputPanel,
  QuoteSummary,
  TransactionDetails,
} from "./quote-panels";
import { useSwap } from "./use-swap";

export function SwapWorkspace(props: Parameters<typeof useSwap>[0]) {
  const swap = useSwap(props);
  return (
    <div className="w-full">
      <div
        aria-atomic="true"
        aria-label="Transaction status"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {swap.announcementText}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {(
          [
            [
              "Refresh failed",
              swap.refreshError === null
                ? null
                : `The previous snapshot remains visible. ${swap.refreshError}`,
            ],
            ["Request history unavailable", swap.requestStorageError],
            ["Queue processing unavailable", swap.crankStorageError],
            ["Account transaction state unavailable", swap.accountError],
          ] as const
        ).map(([title, message]) =>
          message === null ? null : (
            <Alert key={title} variant="destructive">
              <AlertTitle>{title}</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ),
        )}
        {swap.otherPoolBlocked ? (
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
                ref={swap.headingRef}
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
                id={swap.slippageId}
                value={swap.slippage}
                onChange={swap.changeSlippage}
                result={swap.slippageResult}
                disabled={swap.controlsLocked}
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="relative flex flex-col gap-2">
              <TokenInputPanel
                id={swap.amountId}
                token={swap.tokens.input}
                value={swap.amount}
                error={swap.validationMessage}
                onChange={swap.changeAmount}
                disabled={swap.controlsLocked}
                onMax={swap.maxAmount}
              />
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={`Switch direction to ${swap.tokens.output.symbol} for ${swap.tokens.input.symbol}`}
                onClick={swap.switchDirection}
                disabled={swap.controlsLocked}
                className="relative mx-auto -my-5"
              >
                <ArrowDownUpIcon aria-hidden="true" />
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                />
              </Button>
              <TokenOutputPanel
                token={swap.tokens.output}
                value={swap.output}
              />
            </div>
            {!swap.hasLiquidity ? (
              <Alert variant="destructive" className="mt-4">
                <AlertTitle>Empty pool</AlertTitle>
                <AlertDescription>
                  One or both reserves are zero. Add liquidity before quoting a
                  swap.
                </AlertDescription>
              </Alert>
            ) : null}
            <QuoteSummary
              quote={swap.quote.ok ? swap.quote : null}
              input={swap.tokens.input}
              output={swap.tokens.output}
              slippageValid={swap.slippageResult.ok}
            />
            <Button
              type="button"
              disabled={swap.actionDisabled}
              onClick={() => void swap.executeAction()}
              className="mt-5 min-h-12 w-full text-base sm:text-sm"
            >
              {swap.controlsLocked ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <LockKeyholeIcon data-icon="inline-start" />
              )}
              {swap.actionLabel}
            </Button>
            {swap.workflowError ? (
              <Alert className="mt-4" variant="destructive">
                <AlertTitle>Transaction issue</AlertTitle>
                <AlertDescription>{swap.workflowError}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3 p-4">
            <TransactionDetails
              config={swap.config}
              quote={swap.quote.ok ? swap.quote : null}
              input={swap.tokens.input}
              output={swap.tokens.output}
              slippageValid={swap.slippageResult.ok}
            />
          </CardFooter>
        </Card>
        <Field
          orientation="horizontal"
          data-disabled={swap.modeLocked}
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
            checked={swap.manualProcessing}
            disabled={swap.modeLocked}
            onCheckedChange={(manual) =>
              swap.setProcessingMode(manual ? "manual" : "automatic")
            }
          />
        </Field>
        <RequestList
          automatic={!swap.manualProcessing}
          modeChangeDisabled={swap.modeLocked}
          requests={swap.requests}
          tokenA={swap.snapshot.tokenA}
          tokenB={swap.snapshot.tokenB}
          recoveryRequestId={swap.recoveryRequestId}
          isCheckingRecovery={swap.isCheckingRecovery}
          crankAttempt={swap.crankAttempt}
          isCranking={swap.isCranking}
          crankDisabled={swap.crankStorageError !== null || swap.modeLocked}
          crankRecoveryDisabled={swap.crankRecoveryDisabled}
          onDismiss={swap.dismissRequest}
          onCrank={() => void swap.executeCrank()}
          onCheckCrank={() => void swap.checkCrankStatus()}
          onConfirmCrankRecovery={swap.confirmPreHashCrankRecovery}
          onCheckRecovery={swap.checkRecovery}
          onConfirmRecovery={swap.confirmPreHashRecovery}
          onResolveUntracked={swap.resolveUntrackedRequest}
          onShowManual={() => swap.setProcessingMode("manual")}
        />
        <AllowanceCleanupCard
          config={swap.config}
          snapshot={swap.snapshot}
          readSnapshot={swap.readSnapshot}
          writer={swap.writeBoundary}
          onRefresh={swap.refreshSnapshot}
        />
      </div>
    </div>
  );
}
