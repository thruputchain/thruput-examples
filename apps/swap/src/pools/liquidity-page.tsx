import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { toHex0x } from "@groundhogchain/client";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SlippageSettings } from "@/components/slippage-settings";
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
import { reservedInputForToken } from "@/domain/reservations";
import { AmmPage } from "@/pools/amm-page";
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
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { withOutstandingRequestLock } from "@/transactions/outstanding-request";
import { loadAccountRequestRecords } from "@/transactions/request-collection";
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
  walletPrivateKey,
}: {
  config: AppConfig;
  dependencies?: LiquidityPageDependencies;
  walletPrivateKey?: string | undefined;
}) {
  const [reader] = useState(() => dependencies.readSnapshot ?? createSnapshotReader(config));
  const [writer] = useState(() =>
    dependencies.writer ?? createBrowserLocalWriteBoundary(config, walletPrivateKey)
  );
  const [observer] = useState(() =>
    dependencies.observer ?? createLiquidityObserver(config)
  );
  const snapshotState = usePoolSnapshot(reader);
  const [initialState] = useState(() => readLiquidityState(config));
  const [operations, setOperations] = useState(initialState.operations);
  const [dismissedOperationId, setDismissedOperationId] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<"add" | "remove">("add");
  const [addAmount, setAddAmount] = useState("");
  const [removeAmount, setRemoveAmount] = useState("");
  const [inputIndex, setInputIndex] = useState<LiquidityTokenIndex>(0);
  const [slippage, setSlippage] = useState("1");
  const [manualProcessing, setManualProcessing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(initialState.error);
  const run = dependencies.run ?? runLiquidityOperation;
  const snapshot = snapshotState.snapshot;
  const unresolved = operations.find(({ status }) =>
    status === "active" || status === "queued"
  ) ?? null;
  const latest = operations.at(-1) ?? null;
  const current = unresolved ?? (
    latest !== null && latest.id !== dismissedOperationId ? latest : null
  );
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
      const result = await withOutstandingRequestLock(config, async () => {
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
      await withOutstandingRequestLock(config, async () => {
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
    <AmmPage
      title="Manage liquidity"
      description={`${config.tokenASymbol} / ${config.tokenBSymbol} deposits and redemptions.`}
      actions={snapshot === null ? undefined : (
        <Button size="sm" variant="outline" disabled={snapshotState.isRefreshing} onClick={snapshotState.refresh}>
          <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
          Refresh
        </Button>
      )}
    >
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
              isRunning={isRunning}
              onAmount={setAddAmount}
              onInputIndex={setInputIndex}
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
          onDone={() => {
            setDismissedOperationId(current.id);
            setSelectedKind(current.kind);
            setAddAmount("");
            setRemoveAmount("");
          }}
        />
      )}
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
          onCheckedChange={setManualProcessing}
        />
      </Field>
    </AmmPage>
  );
}

function AddLiquidityCard({
  snapshot,
  amount,
  inputIndex,
  slippage,
  slippageResult,
  quote,
  isRunning,
  onAmount,
  onInputIndex,
  onSlippage,
  onSubmit,
}: {
  snapshot: Awaited<ReturnType<SnapshotReader>> | null;
  amount: string;
  inputIndex: LiquidityTokenIndex;
  slippage: string;
  slippageResult: ReturnType<typeof parseSlippagePercent>;
  quote: ReturnType<typeof deriveAddLiquidityQuote> | null;
  isRunning: boolean;
  onAmount: (value: string) => void;
  onInputIndex: (index: LiquidityTokenIndex) => void;
  onSlippage: (value: string) => void;
  onSubmit: () => void;
}) {
  const inputToken = snapshot === null
    ? null
    : inputIndex === 0 ? snapshot.tokenA : snapshot.tokenB;
  const counterpart = snapshot === null || quote === null || !quote.ok
    ? "--"
    : formatTokenAmount(
        quote.amountsDesired[inputIndex === 0 ? 1 : 0],
        (inputIndex === 0 ? snapshot.tokenB : snapshot.tokenA).decimals,
        8,
      );
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Add liquidity</h2></CardTitle>
        <CardDescription>
          Desired amounts are maximum contributions. Live reserves determine the
          final proportional deposit; estimated LP output has no contract minimum.
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
        <Field>
          <FieldLabel htmlFor="liquidity-amount">
            {inputToken?.symbol ?? "Token"} amount
          </FieldLabel>
          <Input
            id="liquidity-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              type="button"
              variant={inputIndex === 0 ? "default" : "outline"}
              onClick={() => onInputIndex(0)}
            >
              {snapshot?.tokenA.symbol ?? "Token 0"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant={inputIndex === 1 ? "default" : "outline"}
              onClick={() => onInputIndex(1)}
            >
              {snapshot?.tokenB.symbol ?? "Token 1"}
            </Button>
          </div>
          {quote === null || quote.ok ? null : (
            <FieldDescription>{liquidityQuoteError(quote.error)}</FieldDescription>
          )}
        </Field>
        <div className="rounded-xl bg-muted/60 p-4">
          <p className="text-sm text-muted-foreground">Proportional counterpart</p>
          <p className="mt-2 font-mono text-2xl tabular-nums">{counterpart}</p>
          {snapshot === null || quote === null || !quote.ok ? null : (
            <p className="mt-2 text-sm text-muted-foreground">
              Estimated LP {quote.estimatedLiquidity} base units
            </p>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button disabled={isRunning || quote === null || !quote.ok} onClick={onSubmit}>
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
          Burn LP base units for a proportional share of both reserves. Slippage
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
          <FieldLabel htmlFor="remove-liquidity-amount">LP base units</FieldLabel>
          <Input
            id="remove-liquidity-amount"
            inputMode="numeric"
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
                onClick={() => onAmount(liquidityPercentAmount(available, percentage).toString())}
              >
                {percentage}%
              </Button>
            ))}
          </div>
          <FieldDescription>{available} LP base units available.</FieldDescription>
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
  onDone,
}: {
  operation: LiquidityOperation;
  isRunning: boolean;
  requiresConfirmation: boolean;
  onConfirm: () => void;
  onContinue: () => void;
  onDone: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle asChild>
              <h2>{operation.kind === "add" ? "Add" : "Remove"} liquidity progress</h2>
            </CardTitle>
            <CardDescription>Request-safe approval, enqueue, and processing stages.</CardDescription>
          </div>
          <Badge variant="outline">{operation.status}</Badge>
        </div>
      </CardHeader>
      <CardContent>
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
        {operation.kind === "add" && operation.result !== null ? (
          <div className="mt-5 rounded-xl bg-muted/60 p-4 text-sm">
            <p>LP minted: {operation.result.liquidityMinted} base units</p>
            <p>
              Recipient delivery {operation.result.recipientVerified ? "verified" : "unverified"}
            </p>
          </div>
        ) : operation.kind === "remove" && operation.result !== null ? (
          <div className="mt-5 rounded-xl bg-muted/60 p-4 text-sm">
            <p>{operation.result.amountsRedeemed[0]} token 0 base units received</p>
            <p>{operation.result.amountsRedeemed[1]} token 1 base units received</p>
          </div>
        ) : null}
      </CardContent>
      {operation.status === "executed" || operation.status === "failed" ? (
        <CardFooter>
          <Button variant="outline" onClick={onDone}>
            {operation.kind === "add" ? "Add more liquidity" : "Remove more liquidity"}
          </Button>
        </CardFooter>
      ) : (
        <CardFooter>
          <Button disabled={isRunning} onClick={requiresConfirmation ? onConfirm : onContinue}>
            {requiresConfirmation
              ? "Confirm transaction was not signed"
              : operation.status === "queued"
                ? "Crank queue"
                : `Continue ${operation.kind} liquidity`}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
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
  const tokens = [toHex0x(config.tokenAAddress), toHex0x(config.tokenBAddress)] as const;
  const balanceReservations = tokens.map((token) =>
    reservedInputForToken(requests, token)
      + reservedCreationToken(creations, token)
      + reservedLiquidityTokenAmount(liquidity, token)
  ) as unknown as readonly [bigint, bigint];
  const localRequests = requests.filter(({ criteria }) =>
    criteria.handlerAddress === toHex0x(config.handlerAddress)
  );
  const localLiquidity = liquidity.filter(({ handlerAddress }) =>
    handlerAddress === toHex0x(config.handlerAddress)
  );
  return {
    balanceReservations,
    allowanceReservations: tokens.map((token) =>
      reservedInputForToken(localRequests, token)
        + reservedLiquidityTokenAmount(localLiquidity, token)
    ) as unknown as readonly [bigint, bigint],
    liquidityReservation:
      reservedInputForToken(requests, toHex0x(config.liquidityTokenAddress))
      + reservedCreationToken(creations, toHex0x(config.liquidityTokenAddress))
      + reservedLiquidityTokenAmount(liquidity, toHex0x(config.liquidityTokenAddress)),
    liquidityAllowanceReservation:
      reservedLiquidityTokenAmount(
        localLiquidity,
        toHex0x(config.liquidityTokenAddress),
      )
      + reservedInputForToken(
        localRequests,
        toHex0x(config.liquidityTokenAddress),
      ),
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
      error: "Saved account transaction progress is invalid. Clear this site's local data before signing another transaction.",
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
      error: "Saved queue-processing progress is invalid. Clear this site's local data before signing another transaction.",
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
      error: "Saved liquidity progress is invalid. Clear this site's local data before signing another liquidity transaction.",
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
