import { AlertCircleIcon, CheckCircle2Icon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { addressFromHex, toHex0x } from "@groundhogchain/client";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { useProcessingMode } from "@/components/processing-mode";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { GlobalConfig } from "@/config";
import { formatAmount } from "@/domain/amount";
import { reservedInputForToken } from "@/domain/reservations";
import { AmmPage } from "@/pools/amm-page";
import {
  preparePoolCreation,
  type PoolCreationInput,
  type PoolCreationReview,
} from "@/pools/pool-creation";
import { resolvePoolConfig } from "@/pools/pool-context";
import { poolPath } from "@/pools/pool-route";
import { createSnapshotReader } from "@/swap/snapshot";
import {
  confirmCreationStepWasNotSigned,
  resetCreationCrank,
  runCreationWorkflow,
} from "@/transactions/creation-executor";
import {
  archiveCreationWorkflow,
  canArchiveCreationWorkflow,
  createCreationWorkflow,
  creationStepOrder,
  hasBlockingCreationTransaction,
  loadAccountCreationWorkflows,
  loadCreationWorkflow,
  reservedCreationHog,
  reservedCreationToken,
  saveCreationWorkflow,
  type CreationStepName,
  type CreationWorkflow,
} from "@/transactions/creation-workflow";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { withOutstandingRequestLock } from "@/transactions/outstanding-request";
import { hasBlockingAllowanceCleanup } from "@/transactions/allowance-cleanup";
import { loadAccountRequestRecords } from "@/transactions/request-collection";
import {
  loadAccountLiquidityOperations,
  reservedLiquidityTokenAmount,
} from "@/transactions/liquidity-operation";
import type { WriteBoundary } from "@/transactions/write-boundary";

const emptyInput: PoolCreationInput = {
  tokenA: "",
  tokenB: "",
  amountA: "",
  amountB: "",
};

const stepLabels: Record<CreationStepName, string> = {
  fundLiquidityToken: "Fund LP token contract",
  fundPair: "Fund pair contract",
  fundHandler: "Fund handler contract",
  fundDriver: "Fund driver contract",
  approveToken0: "Approve token 0",
  approveToken1: "Approve token 1",
  enqueue: "Create pool and enqueue liquidity",
  crank: "Process liquidity queue",
};

interface PoolCreatePageDependencies {
  prepare?: typeof preparePoolCreation;
  writer?: WriteBoundary;
  run?: typeof runCreationWorkflow;
  verifyResult?: (workflow: CreationWorkflow) => Promise<void>;
}

export function PoolCreatePage({
  config,
  dependencies = {},
  walletPrivateKey,
}: {
  config: GlobalConfig;
  dependencies?: PoolCreatePageDependencies;
  walletPrivateKey?: string | undefined;
}) {
  const navigate = useNavigate();
  const [initialState] = useState(() => readCreationState(config));
  const [writer] = useState(
    () => dependencies.writer ?? createBrowserLocalWriteBoundary(config, walletPrivateKey),
  );
  const [input, setInput] = useState(emptyInput);
  const [review, setReview] = useState<PoolCreationReview | null>(null);
  const [accountWorkflows, setAccountWorkflows] = useState(initialState.workflows);
  const [workflow, setWorkflow] = useState<CreationWorkflow | null>(
    initialState.current,
  );
  const [isReviewing, setIsReviewing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const { mode: processingMode, setMode: setProcessingMode } = useProcessingMode();
  const manualProcessing = processingMode === "manual";
  const [error, setError] = useState<string | null>(initialState.error);
  const prepare = dependencies.prepare ?? preparePoolCreation;
  const run = dependencies.run ?? runCreationWorkflow;
  const currentFactory = toHex0x(config.factoryAddress);
  const recoverable = accountWorkflows.filter((candidate) =>
    candidate.factoryAddress === currentFactory
    && (candidate.status === "active"
      || candidate.status === "queued"
      || (candidate.status === "race" && candidate.requestId !== null))
  );
  const obsolete = accountWorkflows.find((candidate) =>
    candidate.factoryAddress !== currentFactory
    && (candidate.status === "active"
      || candidate.status === "queued"
      || (candidate.status === "race" && candidate.requestId !== null))
  ) ?? null;

  const applyWorkflow = (next: CreationWorkflow) => {
    setWorkflow(next);
    setAccountWorkflows((current) => [
      ...current.filter(({ id }) => id !== next.id),
      next,
    ]);
  };

  async function reviewPool() {
    if (isReviewing || isRunning) return;
    setIsReviewing(true);
    setError(null);
    try {
      const accountWorkflows = loadAccountCreationWorkflows(config);
      const nativeHogHex = toHex0x(config.nativeHogAddress);
      const next = await prepare(
        config,
        input,
        reservedCreationHog(accountWorkflows)
          + reservedCreationToken(accountWorkflows, nativeHogHex)
          + reservedInputForToken(
            loadAccountRequestRecords(config),
            nativeHogHex,
          )
          + reservedLiquidityTokenAmount(
            loadAccountLiquidityOperations(config),
            nativeHogHex,
          ),
      );
      setReview(next);
    } catch (cause) {
      setReview(null);
      setError(describeError(cause));
    } finally {
      setIsReviewing(false);
    }
  }

  async function startOrContinue(processQueue = false) {
    if (isRunning) return;
    setIsRunning(true);
    setError(null);
    try {
      const result = await withOutstandingRequestLock(config, async () => {
        if (hasBlockingAllowanceCleanup(config)) {
          throw new Error("Resolve the account's pending allowance cleanup first");
        }
        let current = workflow;
        if (current === null) {
          if (review === null) throw new Error("Review the pool before creating it");
          const existing = loadAccountCreationWorkflows(config).find((candidate) =>
            candidate.token0.address === review.token0.addressHex
            && candidate.token1.address === review.token1.addressHex
          );
          current = existing ?? saveCreationWorkflow(
            config,
            createCreationWorkflow(config, review),
          );
          applyWorkflow(current);
        } else {
          const stored = loadCreationWorkflow(
            config,
            current.token0.address,
            current.token1.address,
          );
          if (stored === null || stored.id !== current.id) {
            throw new Error("The creation workflow changed in another tab");
          }
          current = stored;
          applyWorkflow(current);
        }
        if (
          current.status === "queued"
          && ["committed", "failed"].includes(current.steps.crank.status)
        ) {
          current = resetCreationCrank(config, current);
          applyWorkflow(current);
        }
        return run(config, current, {
          writeBoundary: writer,
          automaticProcessing: processQueue || !manualProcessing,
          onUpdate: applyWorkflow,
        });
      });
      applyWorkflow(result);
      if (result.status === "executed") {
        if (dependencies.verifyResult !== undefined) {
          await dependencies.verifyResult(result);
        } else {
          const token0 = addressFromHex(result.token0.address);
          const token1 = addressFromHex(result.token1.address);
          const poolConfig = await resolvePoolConfig(config, token0, token1);
          const snapshot = await createSnapshotReader(poolConfig)();
          if (
            snapshot.reserve0 <= 0n
            || snapshot.reserve1 <= 0n
            || snapshot.liquidityTotalSupply <= 0n
            || snapshot.liquidityBalance <= 0n
          ) {
            throw new Error(
              "Mint execution was observed, but the recipient's LP delivery could not be verified from a coherent snapshot",
            );
          }
          navigate(poolPath(token0, token1), { replace: true });
        }
      }
    } catch (cause) {
      setError(describeError(cause));
      const next = readCreationState(config);
      setAccountWorkflows(next.workflows);
      setWorkflow(next.current);
    } finally {
      setIsRunning(false);
    }
  }

  async function confirmNotSigned() {
    if (workflow === null) return;
    setIsRunning(true);
    setError(null);
    try {
      const next = await withOutstandingRequestLock(config, async () => {
        const stored = loadCreationWorkflow(
          config,
          workflow.token0.address,
          workflow.token1.address,
        );
        if (stored === null || stored.id !== workflow.id) {
          throw new Error("The creation workflow changed in another tab");
        }
        if (blockingStep === null) {
          throw new Error("The creation workflow no longer requires confirmation");
        }
        return confirmCreationStepWasNotSigned(
          config,
          stored,
          blockingStep,
        );
      });
      applyWorkflow(next);
    } catch (cause) {
      setError(describeError(cause));
      const next = readCreationState(config);
      setAccountWorkflows(next.workflows);
      setWorkflow(next.current);
    } finally {
      setIsRunning(false);
    }
  }

  async function archiveObsoleteWorkflow() {
    if (obsolete === null || isRunning) return;
    setIsRunning(true);
    setError(null);
    try {
      const archived = await withOutstandingRequestLock(config, async () =>
        archiveCreationWorkflow(config, obsolete)
      );
      setAccountWorkflows((current) => [
        ...current.filter(({ id }) => id !== archived.id),
        archived,
      ]);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setIsRunning(false);
    }
  }

  const blockingStep = workflow === null
    ? null
    : creationStepOrder.find((name) => {
        const status = workflow.steps[name].status;
        return status === "signing" || status === "indeterminate";
      }) ?? null;
  const requiresPreHashConfirmation = blockingStep !== null
    && workflow!.steps[blockingStep].transactionHash === null;

  return (
    <AmmPage
      title="Create pool"
      description="Review deterministic contracts, fixed development funding, and exact initial liquidity before signing."
    >
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Creation paused</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {obsolete === null ? null : (
        <Alert>
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Obsolete deployment workflow</AlertTitle>
          <AlertDescription>
            A workflow from another factory still reserves this account.
            {canArchiveCreationWorkflow(obsolete)
              ? " It has no accepted request or unresolved transaction and can be archived if that disposable deployment is gone."
              : " It has live or uncertain transaction state and must remain reserved until recovered with its original deployment."}
          </AlertDescription>
          {canArchiveCreationWorkflow(obsolete) ? (
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              disabled={isRunning}
              onClick={archiveObsoleteWorkflow}
            >
              Archive obsolete workflow
            </Button>
          ) : null}
        </Alert>
      )}

      {recoverable.length <= 1 ? null : (
        <Card>
          <CardHeader>
            <CardTitle asChild><h2>Recoverable workflows</h2></CardTitle>
            <CardDescription>Select the pool creation to inspect or continue.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {recoverable.map((candidate) => (
              <Button
                key={candidate.id}
                size="sm"
                variant={candidate.id === workflow?.id ? "default" : "outline"}
                onClick={() => setWorkflow(candidate)}
              >
                {candidate.token0.symbol} / {candidate.token1.symbol}
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      {workflow === null ? (
        <CreationForm
          input={input}
          isReviewing={isReviewing}
          onChange={(field, value) => {
            setInput((current) => ({ ...current, [field]: value }));
            setReview(null);
          }}
          onReview={reviewPool}
        />
      ) : null}

      {review !== null && workflow === null ? (
        <CreationReviewCard
          review={review}
          isRunning={isRunning}
          onCreate={() => startOrContinue(false)}
        />
      ) : null}

      {workflow === null ? null : (
        <CreationProgressCard
          workflow={workflow}
          isRunning={isRunning}
          requiresPreHashConfirmation={requiresPreHashConfirmation}
          onConfirmNotSigned={confirmNotSigned}
          onContinue={() => startOrContinue(
            workflow.status === "queued"
            || (workflow.status === "race" && workflow.requestId !== null),
          )}
          onStartOver={() => {
            if (workflow !== null) {
              setAccountWorkflows((current) =>
                current.filter(({ id }) => id !== workflow.id)
              );
            }
            setWorkflow(null);
            setReview(null);
            setInput(emptyInput);
            setError(null);
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
          disabled={isRunning || workflow?.status === "queued"}
          onCheckedChange={(manual) =>
            setProcessingMode(manual ? "manual" : "automatic")}
        />
      </Field>
    </AmmPage>
  );
}

function CreationForm({
  input,
  isReviewing,
  onChange,
  onReview,
}: {
  input: PoolCreationInput;
  isReviewing: boolean;
  onChange: (field: keyof PoolCreationInput, value: string) => void;
  onReview: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Token pair</h2></CardTitle>
        <CardDescription>
          Enter existing ERC20 contracts and the exact amounts for the first deposit.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 md:grid-cols-2">
        <TokenFields
          label="Token A"
          address={input.tokenA}
          amount={input.amountA}
          onAddress={(value) => onChange("tokenA", value)}
          onAmount={(value) => onChange("amountA", value)}
        />
        <TokenFields
          label="Token B"
          address={input.tokenB}
          amount={input.amountB}
          onAddress={(value) => onChange("tokenB", value)}
          onAmount={(value) => onChange("amountB", value)}
        />
      </CardContent>
      <CardFooter>
        <Button disabled={isReviewing} onClick={onReview}>
          {isReviewing ? "Reviewing pool…" : "Review pool"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TokenFields({
  label,
  address,
  amount,
  onAddress,
  onAmount,
}: {
  label: string;
  address: string;
  amount: string;
  onAddress: (value: string) => void;
  onAmount: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-foreground/10 p-4">
      <h2 className="font-heading font-semibold">{label}</h2>
      <Field>
        <FieldLabel htmlFor={`${label}-address`}>Contract address</FieldLabel>
        <Input
          id={`${label}-address`}
          autoComplete="off"
          className="font-mono"
          value={address}
          onChange={(event) => onAddress(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${label}-amount`}>Initial amount</FieldLabel>
        <Input
          id={`${label}-amount`}
          autoComplete="off"
          inputMode="decimal"
          value={amount}
          onChange={(event) => onAmount(event.target.value)}
        />
        <FieldDescription>Desired amount and exact initial minimum.</FieldDescription>
      </Field>
    </div>
  );
}

function CreationReviewCard({
  review,
  isRunning,
  onCreate,
}: {
  review: PoolCreationReview;
  isRunning: boolean;
  onCreate: () => void;
}) {
  const destinations = [
    ["LP token", review.pool.liquidityToken],
    ["Pair", review.pool.pair],
    ["Handler", review.pool.handler],
    ["Driver", review.pool.driver],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Creation review</h2></CardTitle>
        <CardDescription>
          This ratio establishes initial liquidity. It is not a market price.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <dl className="grid gap-3 text-sm">
          <ReviewRow
            label={review.token0.symbol}
            value={formatAmount(review.token0.amount, review.token0.decimals)}
          />
          <ReviewRow
            label={review.token1.symbol}
            value={formatAmount(review.token1.amount, review.token1.decimals)}
          />
          <ReviewRow label="Initial ratio" value={`${formatAmount(
            review.token0.amount,
            review.token0.decimals,
          )} ${review.token0.symbol} : ${formatAmount(
            review.token1.amount,
            review.token1.decimals,
          )} ${review.token1.symbol}`} />
          <ReviewRow
            label="Estimated LP before lock"
            value={`${review.initialLiquidity} base units`}
          />
          <ReviewRow
            label={`${review.token0.symbol} approval`}
            value={`${review.token0.approvalDifference} base units`}
          />
          <ReviewRow
            label={`${review.token1.symbol} approval`}
            value={`${review.token1.approvalDifference} base units`}
          />
        </dl>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="font-medium">Fixed development storage reserve</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {review.totalFixedFunding} HOG base units total. This conservative
              configured amount is not a fee or quote, is not refunded, does not
              reimburse factory growth, and is not atomic with pool creation.
            </p>
          </div>
          <ul className="grid gap-2 text-sm">
            {destinations.map(([label, address]) => (
              <li className="flex items-center justify-between gap-4" key={label}>
                <span className="flex flex-col">
                  <span>{label}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {review.fixedFundingPerContract} HOG base units
                  </span>
                </span>
                <BlockchainIdentifier
                  value={toHex0x(address)}
                  label={`${label} address`}
                />
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
      <CardFooter>
        <Button disabled={isRunning} onClick={onCreate}>
          {isRunning ? "Creating pool…" : "Create pool"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-foreground/10 pb-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function CreationProgressCard({
  workflow,
  isRunning,
  requiresPreHashConfirmation,
  onConfirmNotSigned,
  onContinue,
  onStartOver,
}: {
  workflow: CreationWorkflow;
  isRunning: boolean;
  requiresPreHashConfirmation: boolean;
  onConfirmNotSigned: () => void;
  onContinue: () => void;
  onStartOver: () => void;
}) {
  const blocking = hasBlockingCreationTransaction(workflow);
  const acceptedRace = workflow.status === "race" && workflow.requestId !== null;
  const terminal = ["executed", "failed", "race"].includes(workflow.status)
    && !acceptedRace;
  const actionLabel = blocking
    ? "Check transaction and continue"
    : workflow.status === "queued" || acceptedRace
      ? workflow.steps.crank.status === "committed"
        ? "Retry queue processing"
        : "Process liquidity queue"
      : "Continue creation";
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle asChild><h2>Creation progress</h2></CardTitle>
            <CardDescription>
              {workflow.token0.symbol} / {workflow.token1.symbol}
            </CardDescription>
          </div>
          <Badge variant="outline">{workflow.status}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <ol aria-label="Pool creation stages" className="grid gap-3">
          {creationStepOrder.map((name) => {
            const step = workflow.steps[name];
            return (
              <li className="flex items-start gap-3" key={name}>
                <StepIcon status={step.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{stepLabels[name]}</span>
                    <span className="text-xs text-muted-foreground">{step.status}</span>
                  </div>
                  {step.message === null ? null : (
                    <p className="mt-1 text-sm text-muted-foreground">{step.message}</p>
                  )}
                  {step.transactionHash === null ? null : (
                    <div className="mt-1 text-xs">
                      <BlockchainIdentifier
                        value={step.transactionHash}
                        label={`${stepLabels[name]} transaction hash`}
                      />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
      {terminal ? (
        <CardFooter>
          <Button variant="outline" onClick={onStartOver}>Start another pool</Button>
        </CardFooter>
      ) : (
        <CardFooter className="gap-3">
          {requiresPreHashConfirmation ? (
            <Button disabled={isRunning} variant="destructive" onClick={onConfirmNotSigned}>
              Confirm transaction was not signed
            </Button>
          ) : (
            <Button disabled={isRunning} onClick={onContinue}>
              {isRunning ? "Working…" : actionLabel}
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function StepIcon({ status }: { status: CreationWorkflow["steps"][CreationStepName]["status"] }) {
  if (status === "committed" || status === "skipped") {
    return <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-5 text-primary" />;
  }
  if (status === "signing") {
    return <LoaderCircleIcon aria-hidden="true" className="mt-0.5 size-5 animate-spin" />;
  }
  if (status === "failed" || status === "indeterminate") {
    return <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-5 text-destructive" />;
  }
  return <CircleIcon aria-hidden="true" className="mt-0.5 size-5 text-muted-foreground" />;
}

function readCreationState(config: GlobalConfig): {
  workflows: CreationWorkflow[];
  current: CreationWorkflow | null;
  error: string | null;
} {
  try {
    const workflows = loadAccountCreationWorkflows(config);
    const current = workflows
      .filter((workflow) => workflow.factoryAddress === toHex0x(config.factoryAddress))
      .filter((workflow) =>
        workflow.status === "active"
        || workflow.status === "queued"
        || (workflow.status === "race" && workflow.requestId !== null)
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
    return { workflows, current, error: null };
  } catch {
    return {
      workflows: [],
      current: null,
      error:
        "Stored account creation workflows could not be loaded safely. Clear or repair local site data before signing.",
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Pool creation could not continue";
}
