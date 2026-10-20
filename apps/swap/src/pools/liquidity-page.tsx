import { AlertCircleIcon } from "lucide-react";
import { toBase58 } from "@thruputchain/client";
import { useState } from "react";
import { useClient } from "@thruputchain/react";

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
import { Field, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AppConfig } from "@/config";
import { requiredAllowanceFor } from "@/domain/allowance-exposure";
import { availableBalance, reservedInputForToken } from "@/domain/reservations";
import { PoolPage } from "@/pools/pool-page";
import {
  deriveAddLiquidityQuote,
  deriveRemoveLiquidityQuote,
  liquidityPercentAmount,
  type LiquidityTokenIndex,
} from "@/pools/liquidity-model";
import { formatTokenAmount, parseSlippagePercent } from "@/swap/model";
import { createSnapshotReader, type SnapshotReader } from "@/swap/snapshot";
import { usePoolSnapshot } from "@/swap/use-pool-snapshot";
import {
  loadAccountCreationWorkflows,
  reservedCreationToken,
} from "@/transactions/creation-workflow";
import {
  confirmLiquidityCrankWasNotSigned,
  confirmLiquidityStepWasNotSigned,
  runLiquidityOperation,
} from "@/transactions/liquidity-executor";
import { isBlockingCrankAttempt, loadCrankAttempt } from "@/transactions/crank-attempt";
import {
  createAddLiquidityOperation,
  createRemoveLiquidityOperation,
  loadAccountLiquidityOperations,
  loadLiquidityOperations,
  reservedLiquidityTokenAmount,
  saveLiquidityOperations,
  type LiquidityOperation,
  type LiquidityStepName,
} from "@/transactions/liquidity-operation";
import { createLiquidityObserver, type LiquidityObserver } from "@/transactions/liquidity-observer";
import { useTransactions } from "@/transactions/use-transactions";
import { withAccountLock } from "@/transactions/account-lock";
import { loadAccountRequestRecords } from "@/transactions/request-collection";
import { hasBlockingAllowanceCleanup } from "@/transactions/allowance-cleanup";
import type { WriteBoundary } from "@/transactions/write-boundary";

interface LiquidityPageDependencies {
  readSnapshot?: SnapshotReader;
  writer?: WriteBoundary;
  run?: typeof runLiquidityOperation;
  observer?: LiquidityObserver;
}

export function LiquidityPage({
  config,
  dependencies = {},
}: {
  config: AppConfig;
  dependencies?: LiquidityPageDependencies;
}) {
  const client = useClient();
  const [reader] = useState(() => dependencies.readSnapshot ?? createSnapshotReader(config, client));
  const connectedWriter = useTransactions(config);
  const writer = dependencies.writer ?? connectedWriter;
  const [observer] = useState(() =>
    dependencies.observer ?? createLiquidityObserver(config, client)
  );
  const snapshotState = usePoolSnapshot(reader, config);
  const [initialState] = useState(() => readLiquidityState(config));
  const [operations, setOperations] = useState(initialState.operations);
  const [selectedKind, setSelectedKind] = useState<"add" | "remove">("add");
  const [addAmount, setAddAmount] = useState("");
  const [removeAmount, setRemoveAmount] = useState("");
  const [inputIndex, setInputIndex] = useState<LiquidityTokenIndex>(0);
  const [slippage, setSlippage] = useState("1");
  const { mode: processingMode, setMode: setProcessingMode } = useProcessingMode();
  const manualProcessing = processingMode === "manual";
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(initialState.error);
  const run = dependencies.run ?? runLiquidityOperation;
  const snapshot = snapshotState.snapshot;
  const unresolved = operations.find(({ status }) =>
    status === "active" || status === "queued"
  ) ?? null;
  const current = unresolved;
  const history = operations.filter(({ status }) =>
    status === "executed" || status === "failed"
  ).sort((left, right) => right.updatedAt - left.updatedAt);
  const accountStateResult = safeReadAccountReservations(config, current?.id ?? null);
  const accountState = accountStateResult.reservations;
  const crankState = current?.status === "queued"
    ? safeLoadCrankAttempt(config)
    : { attempt: null, error: null };
  const displayError = accountStateResult.error ?? crankState.error ?? error;
  const slippageResult = parseSlippagePercent(slippage);
  const addQuote = snapshot === null || displayError !== null || !slippageResult.ok
    ? null
    : deriveAddLiquidityQuote(
        snapshot,
        inputIndex,
        addAmount,
        slippageResult.basisPoints,
        accountState.balanceReservations,
        accountState.allowanceReservations,
      );
  const removeQuote = snapshot === null || displayError !== null || !slippageResult.ok
    ? null
    : deriveRemoveLiquidityQuote(
        snapshot,
        removeAmount,
        slippageResult.basisPoints,
        accountState.liquidityReservation,
        accountState.liquidityAllowanceReservation,
      );
  const blockingStep = current === null ? null : firstBlockingStep(current);
  const localCrank = crankState.attempt;
  const crankRequiresConfirmation = localCrank !== null
    && isBlockingCrankAttempt(localCrank)
    && localCrank.transactionHash === null;
  const requiresConfirmation = crankRequiresConfirmation || (
    blockingStep !== null && current!.steps[blockingStep].transactionHash === null
  );

  const applyOperation = (operation: LiquidityOperation) => {
    const stored = readLiquidityState(config);
    setOperations(stored.error === null
      ? stored.operations
      : (existing) => [
          ...existing.filter(({ id }) => id !== operation.id),
          operation,
        ]
    );
  };

  async function submitOrContinue(processQueue = false) {
    if (isRunning || snapshot === null) return;
    setIsRunning(true);
    setError(null);
    try {
      const result = await withAccountLock(config, async () => {
        if (hasBlockingAllowanceCleanup(config)) {
          throw new Error("Resolve the account's pending allowance cleanup first");
        }
        let operation = current;
        if (operation === null) {
          const quote = selectedKind === "add" ? addQuote : removeQuote;
          if (quote === null || !quote.ok || !slippageResult.ok) {
            throw new Error("Review a valid liquidity amount before continuing");
          }
          const freshSnapshot = await reader();
          const freshState = readAccountReservations(config, null);
          if (selectedKind === "add") {
            if (!addQuote?.ok) throw new Error("Review the add-liquidity quote");
            const fresh = deriveAddLiquidityQuote(
              freshSnapshot,
              inputIndex,
              addAmount,
              slippageResult.basisPoints,
              freshState.balanceReservations,
              freshState.allowanceReservations,
            );
            if (
              !fresh.ok
              || fresh.amountsDesired[0] !== addQuote.amountsDesired[0]
              || fresh.amountsDesired[1] !== addQuote.amountsDesired[1]
              || fresh.amountsMin[0] < addQuote.amountsMin[0]
              || fresh.amountsMin[1] < addQuote.amountsMin[1]
            ) throw new Error("The pool or account changed. Review the updated quote.");
            operation = createAddLiquidityOperation(config, {
              amountsDesired: fresh.amountsDesired,
              amountsMin: fresh.amountsMin,
              estimatedLiquidity: fresh.estimatedLiquidity,
              liquidityBalanceBefore: freshSnapshot.liquidityBalance,
              reservesBefore: [freshSnapshot.reserve0, freshSnapshot.reserve1],
            });
          } else {
            if (!removeQuote?.ok) throw new Error("Review the remove-liquidity quote");
            const fresh = deriveRemoveLiquidityQuote(
              freshSnapshot,
              removeAmount,
              slippageResult.basisPoints,
              freshState.liquidityReservation,
              freshState.liquidityAllowanceReservation,
            );
            if (
              !fresh.ok
              || fresh.liquidity !== removeQuote.liquidity
              || fresh.amountsMin[0] < removeQuote.amountsMin[0]
              || fresh.amountsMin[1] < removeQuote.amountsMin[1]
            ) throw new Error("The pool or account changed. Review the updated quote.");
            operation = createRemoveLiquidityOperation(config, {
              liquidity: fresh.liquidity,
              amountsMin: fresh.amountsMin,
            });
          }
          saveLiquidityOperations(config, [
            ...loadLiquidityOperations(config),
            operation,
          ]);
          applyOperation(operation);
        }
        return run(config, operation, {
          writeBoundary: writer,
          readSnapshot: reader,
          observer,
          automaticProcessing: processQueue || !manualProcessing,
          onUpdate: applyOperation,
        });
      });
      applyOperation(result);
      await snapshotState.refresh();
      if (result.status === "executed") {
        setAddAmount("");
        setRemoveAmount("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Liquidity could not continue");
      setOperations(readLiquidityState(config).operations);
    } finally {
      setIsRunning(false);
    }
  }

  async function confirmNotSigned() {
    if (current === null || isRunning) return;
    setIsRunning(true);
    try {
      await withAccountLock(config, async () => {
        if (crankRequiresConfirmation) {
          confirmLiquidityCrankWasNotSigned(config);
          return;
        }
        if (blockingStep === null) throw new Error("The liquidity operation advanced");
        applyOperation(confirmLiquidityStepWasNotSigned(config, current, blockingStep));
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recovery could not continue");
      setOperations(readLiquidityState(config).operations);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <PoolPage
      title="Manage liquidity"
      description={`${config.tokenASymbol} / ${config.tokenBSymbol} deposits and redemptions.`}
    >
      <div className="flex flex-wrap gap-3 text-sm">
        <BlockchainIdentifier kind="address" value={toBase58(config.tokenAAddress)} label="Token A address" />
        <BlockchainIdentifier kind="address" value={toBase58(config.tokenBAddress)} label="Token B address" />
      </div>
      {displayError === null ? null : (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Liquidity paused</AlertTitle>
          <AlertDescription>{displayError}</AlertDescription>
        </Alert>
      )}
      {snapshot === null || snapshot.feeTo === null ? null : (
        <Alert>
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Protocol fees enabled</AlertTitle>
          <AlertDescription>
            Liquidity changes are disabled until fee-adjusted LP estimates and
            minimum checks are supported.
          </AlertDescription>
        </Alert>
      )}
      {current === null ? (
        <>
          <div aria-label="Liquidity action" className="grid grid-cols-2 rounded-xl bg-muted p-1">
            <Button
              aria-pressed={selectedKind === "add"}
              variant={selectedKind === "add" ? "secondary" : "ghost"}
              onClick={() => setSelectedKind("add")}
            >
              Add
            </Button>
            <Button
              aria-pressed={selectedKind === "remove"}
              variant={selectedKind === "remove" ? "secondary" : "ghost"}
              onClick={() => setSelectedKind("remove")}
            >
              Remove
            </Button>
          </div>
          {selectedKind === "add" ? (
            <AddLiquidityCard
              snapshot={snapshot}
              amount={addAmount}
              inputIndex={inputIndex}
              slippage={slippage}
              slippageResult={slippageResult}
              quote={addQuote}
              availableBalances={snapshot === null
                ? [0n, 0n]
                : [
                  availableBalance(
                    snapshot.tokenA.balance,
                    accountState.balanceReservations[0],
                  ),
                  availableBalance(
                    snapshot.tokenB.balance,
                    accountState.balanceReservations[1],
                  ),
                ]}
              isRunning={isRunning}
              onAmount={(index, value) => {
                setInputIndex(index);
                setAddAmount(value);
              }}
              onSlippage={setSlippage}
              onSubmit={() => submitOrContinue(false)}
            />
          ) : (
            <RemoveLiquidityCard
              snapshot={snapshot}
              amount={removeAmount}
              slippage={slippage}
              slippageResult={slippageResult}
              quote={removeQuote}
              reservedLiquidity={accountState.liquidityReservation}
              isRunning={isRunning}
              onAmount={setRemoveAmount}
              onSlippage={setSlippage}
              onSubmit={() => submitOrContinue(false)}
            />
          )}
        </>
      ) : (
        <OperationCard
          operation={current}
          isRunning={isRunning}
          requiresConfirmation={requiresConfirmation}
          onConfirm={confirmNotSigned}
          onContinue={() => submitOrContinue(current.status === "queued")}
        />
      )}
      <LiquidityHistory operations={history} snapshot={snapshot} />
      <AllowanceCleanupCard
        config={config}
        snapshot={snapshot}
        readSnapshot={reader}
        writer={writer}
        onRefresh={snapshotState.refresh}
      />
      <Field orientation="horizontal">
        <div>
          <FieldTitle>Manual queue processing</FieldTitle>
          <FieldDescription>
            Enqueue without automatically submitting the driver transaction.
          </FieldDescription>
        </div>
        <Switch
          aria-label="Manual queue processing"
          checked={manualProcessing}
          disabled={isRunning || current?.status === "queued"}
          onCheckedChange={(manual) =>
            setProcessingMode(manual ? "manual" : "automatic")}
        />
      </Field>
    </PoolPage>
  );
}

function AddLiquidityCard({
  snapshot,
  amount,
  inputIndex,
  slippage,
  slippageResult,
  quote,
  availableBalances,
  isRunning,
  onAmount,
  onSlippage,
  onSubmit,
}: {
  snapshot: Awaited<ReturnType<SnapshotReader>> | null;
  amount: string;
  inputIndex: LiquidityTokenIndex;
  slippage: string;
  slippageResult: ReturnType<typeof parseSlippagePercent>;
  quote: ReturnType<typeof deriveAddLiquidityQuote> | null;
  availableBalances: readonly [bigint, bigint];
  isRunning: boolean;
  onAmount: (index: LiquidityTokenIndex, value: string) => void;
  onSlippage: (value: string) => void;
  onSubmit: () => void;
}) {
  const quotedAmounts = quote !== null && "amountsDesired" in quote
    ? quote.amountsDesired
    : null;
  const values = snapshot === null
    ? [amount, ""] as const
    : [
        inputIndex === 0
          ? amount
          : quotedAmounts === null
            ? ""
            : formatTokenAmount(quotedAmounts[0], snapshot.tokenA.decimals, 8),
        inputIndex === 1
          ? amount
          : quotedAmounts === null
            ? ""
            : formatTokenAmount(quotedAmounts[1], snapshot.tokenB.decimals, 8),
      ] as const;
  const insufficientTokenIndexes = quote !== null && !quote.ok && quote.error === "balance"
    ? quote.insufficientTokenIndexes
    : [];
  const insufficientSymbols = insufficientTokenIndexes.length > 0
    ? insufficientTokenIndexes.map((index) =>
        index === 0 ? snapshot?.tokenA.symbol : snapshot?.tokenB.symbol
      ).filter((symbol): symbol is string => symbol !== undefined)
    : [];
  const missingSymbols = snapshot === null
    ? []
    : availableBalances.flatMap((balance, index) =>
        balance <= 0n
          ? [index === 0 ? snapshot.tokenA.symbol : snapshot.tokenB.symbol]
          : []
      );
  const balanceWarningSymbols = insufficientSymbols.length > 0
    ? insufficientSymbols
    : missingSymbols;
  const tokenABalanceUnavailable = snapshot !== null && (
    availableBalances[0] <= 0n || insufficientTokenIndexes.includes(0)
  );
  const tokenBBalanceUnavailable = snapshot !== null && (
    availableBalances[1] <= 0n || insufficientTokenIndexes.includes(1)
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Add liquidity</h2></CardTitle>
        <CardDescription>
          Enter either token amount. The other amount is calculated from the
          current pool ratio, and both tokens are deposited from your wallet.
        </CardDescription>
        <CardAction>
          <SlippageSettings
            id="add-liquidity-slippage"
            value={slippage}
            onChange={onSlippage}
            result={slippageResult}
            disabled={isRunning}
            description="Set the minimum token amounts accepted for this deposit."
          />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={tokenABalanceUnavailable}>
          <FieldLabel htmlFor="liquidity-token-a-amount">
            {snapshot?.tokenA.symbol ?? "Token 0"} amount
          </FieldLabel>
          <Input
            id="liquidity-token-a-amount"
            inputMode="decimal"
            value={values[0]}
            aria-invalid={tokenABalanceUnavailable}
            aria-describedby={tokenABalanceUnavailable
              ? "add-liquidity-balance-warning"
              : undefined}
            onChange={(event) => onAmount(0, event.target.value)}
          />
          <FieldDescription>
            {inputIndex === 0 ? "Enter an amount." : "Calculated from the current pool ratio."}
          </FieldDescription>
        </Field>
        <Field data-invalid={tokenBBalanceUnavailable}>
          <FieldLabel htmlFor="liquidity-token-b-amount">
            {snapshot?.tokenB.symbol ?? "Token 1"} amount
          </FieldLabel>
          <Input
            id="liquidity-token-b-amount"
            inputMode="decimal"
            value={values[1]}
            aria-invalid={tokenBBalanceUnavailable}
            aria-describedby={tokenBBalanceUnavailable
              ? "add-liquidity-balance-warning"
              : undefined}
            onChange={(event) => onAmount(1, event.target.value)}
          />
          <FieldDescription>
            {inputIndex === 1 ? "Enter an amount." : "Calculated from the current pool ratio."}
          </FieldDescription>
        </Field>
        {balanceWarningSymbols.length === 0 ? null : (
          <Alert variant="destructive" className="sm:col-span-2">
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>Both tokens are required</AlertTitle>
            <AlertDescription id="add-liquidity-balance-warning">
              Your available {balanceWarningSymbols.join(" and ")} balance is insufficient
              for this deposit. {insufficientSymbols.length > 0
                ? "Reduce the amount or fund the wallet before continuing."
                : "Fund the wallet before continuing."}
            </AlertDescription>
          </Alert>
        )}
        {quote === null || quote.ok || quote.error === "balance" ? null : (
          <FieldDescription className="sm:col-span-2">
            {liquidityQuoteError(quote.error)}
          </FieldDescription>
        )}
        {snapshot === null || quote === null || !quote.ok ? null : (
          <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/60 p-4 sm:col-span-2">
            <span className="text-sm text-muted-foreground">Estimated LP output</span>
            <span className="font-mono tabular-nums">
              {formatTokenAmount(
                quote.estimatedLiquidity,
                snapshot.liquidityTokenDecimals,
                8,
              )} {snapshot.liquidityTokenSymbol}
            </span>
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button
          disabled={isRunning || missingSymbols.length > 0 || quote === null || !quote.ok}
          onClick={onSubmit}
        >
          {isRunning ? "Adding liquidity..." : "Add liquidity"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function RemoveLiquidityCard({
  snapshot,
  amount,
  slippage,
  slippageResult,
  quote,
  reservedLiquidity,
  isRunning,
  onAmount,
  onSlippage,
  onSubmit,
}: {
  snapshot: Awaited<ReturnType<SnapshotReader>> | null;
  amount: string;
  slippage: string;
  slippageResult: ReturnType<typeof parseSlippagePercent>;
  quote: ReturnType<typeof deriveRemoveLiquidityQuote> | null;
  reservedLiquidity: bigint;
  isRunning: boolean;
  onAmount: (value: string) => void;
  onSlippage: (value: string) => void;
  onSubmit: () => void;
}) {
  const available = snapshot === null || snapshot.liquidityBalance <= reservedLiquidity
    ? 0n
    : snapshot.liquidityBalance - reservedLiquidity;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Remove liquidity</h2></CardTitle>
        <CardDescription>
          Burn LP tokens for a proportional share of both reserves. Slippage
          protects the minimum amount received for each token.
        </CardDescription>
        <CardAction>
          <SlippageSettings
            id="remove-liquidity-slippage"
            value={slippage}
            onChange={onSlippage}
            result={slippageResult}
            disabled={isRunning}
            description="Set the minimum token amounts accepted for this redemption."
          />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="remove-liquidity-amount">
            {snapshot?.liquidityTokenSymbol ?? "LP"} amount
          </FieldLabel>
          <Input
            id="remove-liquidity-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {([25, 50, 75, 100] as const).map((percentage) => (
              <Button
                key={percentage}
                size="sm"
                type="button"
                variant="outline"
                disabled={available === 0n}
                onClick={() => onAmount(formatTokenAmount(
                  liquidityPercentAmount(available, percentage),
                  snapshot?.liquidityTokenDecimals ?? 0,
                  snapshot?.liquidityTokenDecimals ?? 0,
                ))}
              >
                {percentage}%
              </Button>
            ))}
          </div>
          <FieldDescription>
            {formatTokenAmount(
              available,
              snapshot?.liquidityTokenDecimals ?? 0,
              8,
            )} {snapshot?.liquidityTokenSymbol ?? "LP"} available.
          </FieldDescription>
          {quote === null || quote.ok ? null : (
            <FieldDescription>{liquidityQuoteError(quote.error)}</FieldDescription>
          )}
        </Field>
        <div className="rounded-xl bg-muted/60 p-4">
          <p className="text-sm text-muted-foreground">Estimated redemption</p>
          {snapshot === null || quote === null || !quote.ok ? (
            <p className="mt-2 font-mono text-2xl tabular-nums">--</p>
          ) : (
            <div className="mt-2 space-y-1 font-mono text-lg tabular-nums">
              <p>
                {formatTokenAmount(quote.amountsEstimated[0], snapshot.tokenA.decimals, 8)}{" "}
                {snapshot.tokenA.symbol}
              </p>
              <p>
                {formatTokenAmount(quote.amountsEstimated[1], snapshot.tokenB.decimals, 8)}{" "}
                {snapshot.tokenB.symbol}
              </p>
            </div>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button disabled={isRunning || quote === null || !quote.ok} onClick={onSubmit}>
          {isRunning ? "Removing liquidity..." : "Remove liquidity"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function OperationCard({
  operation,
  isRunning,
  requiresConfirmation,
  onConfirm,
  onContinue,
}: {
  operation: LiquidityOperation;
  isRunning: boolean;
  requiresConfirmation: boolean;
  onConfirm: () => void;
  onContinue: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle asChild>
              <h2>{operation.kind === "add" ? "Add" : "Remove"} liquidity progress</h2>
            </CardTitle>
            <CardDescription>{operation.executionMode === "batch"
              ? "Approvals and liquidity submission share one transaction. Queue processing is separate."
              : "Request-safe approval, enqueue, and processing stages."}</CardDescription>
          </div>
          <Badge variant="outline">{operation.status}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {operation.executionMode === "batch" ? (
          <div className="mb-4 grid gap-1 text-sm">
            <span className="font-medium">Liquidity batch</span>
            {operation.steps.enqueue.transactionHash ? (
              <BlockchainIdentifier kind="transaction" value={operation.steps.enqueue.transactionHash} label="Liquidity batch transaction hash" />
            ) : null}
            {operation.steps.enqueue.message ? <p className="text-muted-foreground">{operation.steps.enqueue.message}</p> : null}
          </div>
        ) : null}
        <ol aria-label="Liquidity stages" className="grid gap-2 text-sm">
          {(operation.kind === "add"
            ? ["approveToken0", "approveToken1", "enqueue"] as const
            : ["approveLiquidity", "enqueue"] as const
          ).map((name) => (
            <li className="flex items-center justify-between gap-4" key={name}>
              <span>{stageLabel(name)}</span>
              <span className="text-muted-foreground">{operation.steps[name].status}</span>
            </li>
          ))}
        </ol>
      </CardContent>
      <CardFooter>
        <Button disabled={isRunning} onClick={requiresConfirmation ? onConfirm : onContinue}>
          {requiresConfirmation
            ? "Confirm transaction was not signed"
            : operation.status === "queued"
              ? "Crank queue"
              : `Continue ${operation.kind} liquidity`}
        </Button>
      </CardFooter>
    </Card>
  );
}

function LiquidityHistory({
  operations,
  snapshot,
}: {
  operations: readonly LiquidityOperation[];
  snapshot: Awaited<ReturnType<SnapshotReader>> | null;
}) {
  if (operations.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Liquidity history</h2></CardTitle>
        <CardDescription>
          Recent add and remove operations for this account and pool.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="divide-y divide-foreground/10">
          {operations.map((operation) => (
            <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0" key={operation.id}>
              <div className="flex items-center justify-between gap-4">
                <span className="font-medium">
                  {operation.kind === "add" ? "Added liquidity" : "Removed liquidity"}
                </span>
                <Badge variant="outline">{operation.status}</Badge>
              </div>
              <LiquidityHistoryResult operation={operation} snapshot={snapshot} />
              {operation.requestId === null ? null : (
                <div className="text-xs text-muted-foreground">
                  Request <BlockchainIdentifier
                    kind="identifier"
                    value={operation.requestId}
                    label="Liquidity request ID"
                  />
                </div>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function LiquidityHistoryResult({
  operation,
  snapshot,
}: {
  operation: LiquidityOperation;
  snapshot: Awaited<ReturnType<SnapshotReader>> | null;
}) {
  if (operation.status === "failed" || operation.result === null) {
    return <p className="text-sm text-muted-foreground">The queued request failed.</p>;
  }
  if (operation.kind === "add") {
    const minted = snapshot === null
      ? `${operation.result.liquidityMinted} base units`
      : `${formatTokenAmount(
        BigInt(operation.result.liquidityMinted),
        snapshot.liquidityTokenDecimals,
        8,
      )} ${snapshot.liquidityTokenSymbol}`;
    return (
      <p className="text-sm text-muted-foreground">
        Minted {minted}. Recipient delivery {operation.result.recipientVerified
          ? "verified"
          : "unverified"}.
      </p>
    );
  }
  const redeemed = snapshot === null
    ? `${operation.result.amountsRedeemed[0]} / ${operation.result.amountsRedeemed[1]} base units`
    : `${formatTokenAmount(
      BigInt(operation.result.amountsRedeemed[0]),
      snapshot.tokenA.decimals,
      8,
    )} ${snapshot.tokenA.symbol} and ${formatTokenAmount(
      BigInt(operation.result.amountsRedeemed[1]),
      snapshot.tokenB.decimals,
      8,
    )} ${snapshot.tokenB.symbol}`;
  return <p className="text-sm text-muted-foreground">Received {redeemed}.</p>;
}

function readAccountReservations(
  config: AppConfig,
  excludeOperationId: string | null,
): {
  balanceReservations: readonly [bigint, bigint];
  allowanceReservations: readonly [bigint, bigint];
  liquidityReservation: bigint;
  liquidityAllowanceReservation: bigint;
} {
  const requests = loadAccountRequestRecords(config);
  const creations = loadAccountCreationWorkflows(config);
  const liquidity = loadAccountLiquidityOperations(config)
    .filter(({ id }) => id !== excludeOperationId);
  const tokens = [toBase58(config.tokenAAddress), toBase58(config.tokenBAddress)] as const;
  const balanceReservations = tokens.map((token) =>
    reservedInputForToken(requests, token)
      + reservedCreationToken(creations, token)
      + reservedLiquidityTokenAmount(liquidity, token)
  ) as unknown as readonly [bigint, bigint];
  const localRequests = requests.filter(({ criteria }) =>
    criteria.handlerAddress === toBase58(config.handlerAddress)
  );
  const localLiquidity = liquidity.filter(({ handlerAddress }) =>
    handlerAddress === toBase58(config.handlerAddress)
  );
  return {
    balanceReservations,
    allowanceReservations: tokens.map((token) =>
      requiredAllowanceFor({
        requests: localRequests,
        liquidityOperations: localLiquidity,
        creationWorkflows: creations,
      }, token, toBase58(config.handlerAddress))
    ) as unknown as readonly [bigint, bigint],
    liquidityReservation:
      reservedInputForToken(requests, toBase58(config.liquidityTokenAddress))
      + reservedCreationToken(creations, toBase58(config.liquidityTokenAddress))
      + reservedLiquidityTokenAmount(liquidity, toBase58(config.liquidityTokenAddress)),
    liquidityAllowanceReservation: requiredAllowanceFor({
      requests: localRequests,
      liquidityOperations: localLiquidity,
      creationWorkflows: creations,
    }, toBase58(config.liquidityTokenAddress), toBase58(config.handlerAddress)),
  };
}

function safeReadAccountReservations(
  config: AppConfig,
  excludeOperationId: string | null,
): {
  reservations: ReturnType<typeof readAccountReservations>;
  error: string | null;
} {
  try {
    return {
      reservations: readAccountReservations(config, excludeOperationId),
      error: null,
    };
  } catch {
    return {
      reservations: {
        balanceReservations: [0n, 0n],
        allowanceReservations: [0n, 0n],
        liquidityReservation: 0n,
        liquidityAllowanceReservation: 0n,
      },
      error: "Saved account transaction progress is invalid. Preserve the saved data and resolve pending transactions on the original ledger before signing another transaction.",
    };
  }
}

function safeLoadCrankAttempt(config: AppConfig): {
  attempt: ReturnType<typeof loadCrankAttempt>;
  error: string | null;
} {
  try {
    return { attempt: loadCrankAttempt(config), error: null };
  } catch {
    return {
      attempt: null,
      error: "Saved queue-processing progress is invalid. Preserve the saved data and resolve pending transactions on the original ledger before signing another transaction.",
    };
  }
}

function readLiquidityState(config: AppConfig): {
  operations: LiquidityOperation[];
  error: string | null;
} {
  try {
    return { operations: loadLiquidityOperations(config), error: null };
  } catch {
    return {
      operations: [],
      error: "Saved liquidity progress is invalid. Preserve the saved data and resolve pending transactions on the original ledger before signing another liquidity transaction.",
    };
  }
}

function firstBlockingStep(operation: LiquidityOperation): LiquidityStepName | null {
  return (Object.keys(operation.steps) as LiquidityStepName[]).find((name) => {
    const status = operation.steps[name].status;
    return status === "signing" || status === "indeterminate";
  }) ?? null;
}

function stageLabel(name: LiquidityStepName): string {
  return {
    approveToken0: "Approve token 0",
    approveToken1: "Approve token 1",
    approveLiquidity: "Approve LP token",
    enqueue: "Enqueue liquidity request",
  }[name];
}

function liquidityQuoteError(error: string): string {
  return {
    amount: "Enter a positive amount in the token's supported precision.",
    balance: "The unreserved account balance is insufficient.",
    emptyLiquidity: "This pool does not have usable liquidity.",
    feeEnabled: "Protocol-fee liquidity changes are not supported yet.",
    minimum: "This amount is too small after proportional rounding.",
    slippage: "Slippage must be greater than 0% and no more than 50%.",
  }[error] ?? "The liquidity quote is unavailable.";
}
