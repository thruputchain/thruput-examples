import { AlertCircleIcon, CheckCircle2Icon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { addressFromHex, toHex0x, type CoreGroundhogClient } from "@groundhogchain/client";
import { useClient } from "@groundhogchain/react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { TokenSymbol } from "@/components/token-symbol";
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
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import { formatAmount } from "@/domain/amount";
import { reservedInputForToken } from "@/domain/reservations";
import { AmmPage } from "@/pools/amm-page";
import { readCreationPresets, tokenAddress } from "@/pools/creation-presets";
import { TokenAddressCombobox } from "@/pools/token-address-combobox";
import { useTokenPreview } from "@/pools/token-preview";
import {
  preparePoolCreation,
  type PoolCreationInput,
  type PoolCreationReview,
} from "@/pools/pool-creation";
import { resolvePoolConfig } from "@/pools/pool-context";
import { poolPath } from "@/pools/pool-route";
import { createSnapshotReader } from "@/swap/snapshot";
import { requestPoolRegistrySync } from "@/registry/client";
import {
  confirmCreationStepWasNotSigned,
  continueSupersededCreation,
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
  sameCreationIntent,
  type CreationStepName,
  type CreationWorkflow,
} from "@/transactions/creation-workflow";
import { useWalletWriteBoundary } from "@/wallet/write-context";
import { withAccountLock } from "@/transactions/account-lock";
import {
  hasBlockingAllowanceCleanup,
  confirmAllowanceCleanupWasNotSigned,
  loadAllowanceCleanup,
  runAllowanceCleanup,
} from "@/transactions/allowance-cleanup";
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
  approveFunding: "Approve factory funding",
  createPool: "Create pool contracts",
  approveToken0: "Approve token 0",
  approveToken1: "Approve token 1",
  enqueue: "Submit initial liquidity",
  crank: "Process liquidity queue",
};

interface PoolCreatePageDependencies {
  prepare?: typeof preparePoolCreation;
  writer?: WriteBoundary;
  run?: typeof runCreationWorkflow;
  verifyResult?: (workflow: CreationWorkflow) => Promise<void>;
  readFactoryAllowance?: () => Promise<{ value: bigint; height: bigint }>;
  requestRegistrySync?: typeof requestPoolRegistrySync;
}

export function PoolCreatePage({
  config,
  ...props
}: {
  config: GlobalConfig;
  dependencies?: PoolCreatePageDependencies;
}) {
  const scope = JSON.stringify([
    config.networkIdHex, config.rpcUrl.href, config.registryEnabled,
    toHex0x(config.accountAddress), toHex0x(config.factoryAddress),
    toHex0x(config.routerAddress), toHex0x(config.nativeHogAddress),
  ]);
  return <CreationPage key={scope} config={config} {...props} />;
}

function CreationPage({
  config,
  dependencies = {},
}: {
  config: GlobalConfig;
  dependencies?: PoolCreatePageDependencies;
}) {
  const client = useClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [initialState] = useState(() => readCreationState(config));
  const [presets] = useState(() => {
    if (initialState.current === null && initialState.error === null) {
      return readCreationPresets(location.search);
    }
    const params = new URLSearchParams(location.search);
    const ignored = initialState.current !== null && (params.has("tokenA") || params.has("tokenB"));
    return {
      ...emptyInput,
      warnings: ignored
        ? ["A saved creation is being recovered. Link presets were not applied."]
        : [],
    };
  });
  const connectedWriter = useWalletWriteBoundary();
  const writer = dependencies.writer ?? connectedWriter;
  const [input, setInput] = useState<PoolCreationInput>(() => ({
    ...emptyInput, tokenA: presets.tokenA, tokenB: presets.tokenB,
  }));
  const revision = useRef(0);
  useEffect(() => () => { revision.current += 1; }, []);
  const [review, setReview] = useState<PoolCreationReview | null>(null);
  const [accountWorkflows, setAccountWorkflows] = useState(initialState.workflows);
  const [cleanup, setCleanup] = useState(initialState.cleanup);
  const [workflow, setWorkflow] = useState<CreationWorkflow | null>(
    initialState.current,
  );
  const [isReviewing, setIsReviewing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const { mode: processingMode, setMode: setProcessingMode } = useProcessingMode();
  const manualProcessing = processingMode === "manual";
  const [error, setError] = useState<string | null>(initialState.error);
  const canPreview = workflow === null && initialState.error === null;
  const previewA = useTokenPreview(config, canPreview ? input.tokenA : "", client);
  const previewB = useTokenPreview(config,
    canPreview && tokenAddress(input.tokenB) !== tokenAddress(input.tokenA)
      ? input.tokenB : "", client,
  );
  const networkMismatch = [previewA, previewB].some(({ preview }) =>
    preview?.status === "unavailable" && preview.networkMismatch
  );
  useEffect(() => {
    if (networkMismatch) {
      revision.current += 1;
      setReview(null);
    }
  }, [networkMismatch]);
  const prepare = dependencies.prepare ?? preparePoolCreation;
  const run = dependencies.run ?? runCreationWorkflow;
  const requestRegistrySync = dependencies.requestRegistrySync
    ?? requestPoolRegistrySync;
  const currentFactory = toHex0x(config.factoryAddress);
  const recoverable = accountWorkflows.filter((candidate) =>
    isRecoverableCreationWorkflow(candidate, currentFactory)
  );
  const obsolete = accountWorkflows.find((candidate) =>
    candidate.factoryAddress !== currentFactory
    && (candidate.status === "active"
      || candidate.status === "queued"
      || candidate.status === "race")
  ) ?? null;

  const applyWorkflow = (next: CreationWorkflow) => {
    setWorkflow(next);
    setAccountWorkflows((current) => [
      ...current.filter(({ id }) => id !== next.id),
      next,
    ]);
  };

  async function reviewPool() {
    if (isReviewing || isRunning || initialState.error !== null || networkMismatch) return;
    const generation = ++revision.current;
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
        { client },
      );
      if (generation === revision.current) setReview(next);
    } catch (cause) {
      if (generation === revision.current) {
        setReview(null);
        setError(describeError(cause));
      }
    } finally {
      setIsReviewing(false);
    }
  }

  async function startOrContinue(processQueue = false) {
    if (isRunning || initialState.error !== null || (workflow === null && networkMismatch)) return;
    const generation = revision.current;
    const assertCurrent = () => {
      if (generation !== revision.current) {
        throw new Error("The creation review changed before the account lock was acquired");
      }
      if (workflow !== null) {
        const stored = loadCreationWorkflow(config, workflow.token0.address, workflow.token1.address);
        if (stored === null || stored.id !== workflow.id || !sameCreationIntent(stored, workflow)) {
          throw new Error("The saved creation intent changed; review it before continuing");
        }
      }
    };
    setIsRunning(true);
    setError(null);
    try {
      if (
        workflow !== null
        && (workflow.status === "race" || workflow.status === "failed")
        && workflow.steps.approveFunding.status === "committed"
        && workflow.steps.createPool.status === "failed"
      ) {
        const cleanup = await runAllowanceCleanup(
          config,
          config.nativeHogAddress,
          config.factoryAddress,
          {
            writeBoundary: writer,
            assertCurrent,
            readAllowance: dependencies.readFactoryAllowance
              ?? (() => readFactoryAllowance(config, client)),
          },
        );
        if (cleanup.kind === "pending") {
          throw new Error(
            "The factory allowance cleanup outcome is uncertain. Check it before continuing.",
          );
        }
        if (cleanup.kind === "failed") throw new Error(cleanup.message);
        if (workflow.status === "failed") {
          const archived = await withAccountLock(config, async () => {
            assertCurrent();
            return archiveCreationWorkflow(config, workflow);
          });
          applyWorkflow(archived);
          setCleanup(loadAllowanceCleanup(config));
          return;
        }
      }
      const result = await withAccountLock(config, async () => {
        assertCurrent();
        if (hasBlockingAllowanceCleanup(config)) {
          throw new Error("Resolve the account's pending allowance cleanup first");
        }
        let current = workflow;
        if (current === null) {
          if (review === null) throw new Error("Review the pool before creating it");
          const existing = loadAccountCreationWorkflows(config).find((candidate) =>
            isRecoverableCreationWorkflow(candidate, currentFactory)
            && candidate.token0.address === review.token0.addressHex
            && candidate.token1.address === review.token1.addressHex
          );
          if (existing !== undefined) {
            applyWorkflow(existing);
            throw new Error("A saved creation appeared in another tab. Review its amounts and funding before explicitly continuing.");
          }
          current = saveCreationWorkflow(
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
        if (current.status === "race" && current.requestId === null) {
          current = continueSupersededCreation(config, current);
          applyWorkflow(current);
        }
        let previousCreatePoolStatus = current.steps.createPool.status;
        let syncHintSent = false;
        const hintRegistryAfterCreation = (next: CreationWorkflow) => {
          if (
            config.registryEnabled
            && !syncHintSent
            && previousCreatePoolStatus !== "committed"
            && next.steps.createPool.status === "committed"
          ) {
            syncHintSent = true;
            void requestRegistrySync(config).catch(() => undefined);
          }
          previousCreatePoolStatus = next.steps.createPool.status;
        };
        const result = await run(config, current, {
          client,
          writeBoundary: writer,
          assertCurrent,
          automaticProcessing: processQueue || !manualProcessing,
          onUpdate: (next) => {
            applyWorkflow(next);
            hintRegistryAfterCreation(next);
          },
        });
        hintRegistryAfterCreation(result);
        return result;
      });
      applyWorkflow(result);
      setCleanup(loadAllowanceCleanup(config));
      if (result.status === "executed") {
        if (dependencies.verifyResult !== undefined) {
          await dependencies.verifyResult(result);
        } else {
          if (result.pool === null) throw new Error("The created pool is unavailable");
          const token0 = addressFromHex(result.token0.address);
          const token1 = addressFromHex(result.token1.address);
          const poolConfig = await resolvePoolConfig(config, token0, token1, undefined, client);
          const snapshot = await createSnapshotReader(poolConfig, client)();
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
      setWorkflow((current) => next.workflows.find(({ id }) => id === current?.id) ?? next.current);
      setCleanup(next.cleanup);
    } finally {
      setIsRunning(false);
    }
  }

  async function confirmCleanupNotSigned() {
    if (isRunning) return;
    setIsRunning(true);
    setError(null);
    try {
      await confirmAllowanceCleanupWasNotSigned(config);
      setCleanup(loadAllowanceCleanup(config));
    } catch (cause) {
      setError(describeError(cause));
      setCleanup(loadAllowanceCleanup(config));
    } finally {
      setIsRunning(false);
    }
  }

  async function confirmNotSigned() {
    if (workflow === null) return;
    setIsRunning(true);
    setError(null);
    try {
      const next = await withAccountLock(config, async () => {
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
      const archived = await withAccountLock(config, async () =>
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
      description="Review factory-recommended funding and exact initial liquidity before signing."
    >
      {presets.warnings.map((warning) => (
        <Alert key={warning}>
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Link presets</AlertTitle>
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ))}
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

      {cleanup === null ? null : (
        <Alert>
          <AlertTitle>Pending allowance cleanup</AlertTitle>
          <AlertDescription>
            {cleanup.transactionHash === null
              ? "Confirm only if the account's allowance cleanup transaction was never signed."
              : "The cleanup has a transaction hash and must be observed before continuing."}
          </AlertDescription>
          <BlockchainIdentifier kind="address" value={cleanup.tokenAddress} label="Cleanup token" />
          <BlockchainIdentifier kind="address" value={cleanup.spenderAddress} label="Cleanup spender" />
          {cleanup.transactionHash === null ? (
            <Button disabled={isRunning} variant="destructive" onClick={confirmCleanupNotSigned}>
              Confirm allowance cleanup was not signed
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
              <div key={candidate.id} className="flex flex-col gap-2">
                <Button
                  size="sm"
                  variant={candidate.id === workflow?.id ? "default" : "outline"}
                  disabled={isRunning}
                  onClick={() => setWorkflow(candidate)}
                >
                  <TokenSymbol symbol={candidate.token0.symbol} address={candidate.token0.address} nonInteractive /> / <TokenSymbol symbol={candidate.token1.symbol} address={candidate.token1.address} nonInteractive />
                </Button>
                <div className="flex flex-wrap gap-2 text-xs">
                  <BlockchainIdentifier kind="address" value={candidate.token0.address} label="Recovery token 0 address" />
                  <BlockchainIdentifier kind="address" value={candidate.token1.address} label="Recovery token 1 address" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {workflow === null ? (
        <CreationForm
          config={config}
          previewA={previewA}
          previewB={previewB}
          blocked={initialState.error !== null || networkMismatch || isRunning}
          input={input}
          isReviewing={isReviewing}
          isRunning={isRunning}
          onChange={(field, value) => {
            if (isRunning) return;
            revision.current += 1;
            setInput((current) => ({
              ...current,
              [field]: value,
              ...(field === "tokenA" ? { amountA: "" }
                : field === "tokenB" ? { amountB: "" } : {}),
            }));
            setReview(null);
          }}
          onReview={reviewPool}
        />
      ) : null}

      {review !== null && workflow === null && !networkMismatch ? (
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
            || workflow.status === "race",
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
  config,
  previewA,
  previewB,
  blocked,
  input,
  isReviewing,
  isRunning,
  onChange,
  onReview,
}: {
  config: GlobalConfig;
  previewA: ReturnType<typeof useTokenPreview>;
  previewB: ReturnType<typeof useTokenPreview>;
  blocked: boolean;
  input: PoolCreationInput;
  isReviewing: boolean;
  isRunning: boolean;
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
      <CardContent>
        <fieldset disabled={isRunning} className="grid gap-5 md:grid-cols-2">
          <TokenFields
            config={config}
            preview={previewA}
            otherAddress={input.tokenB}
            label="Token A"
            address={input.tokenA}
            amount={input.amountA}
            onAddress={(value) => onChange("tokenA", value)}
            onAmount={(value) => onChange("amountA", value)}
          />
          <TokenFields
            config={config}
            preview={previewB}
            otherAddress={input.tokenA}
            label="Token B"
            address={input.tokenB}
            amount={input.amountB}
            onAddress={(value) => onChange("tokenB", value)}
            onAmount={(value) => onChange("amountB", value)}
          />
        </fieldset>
      </CardContent>
      <CardFooter>
        <Button
          disabled={isReviewing || blocked
            || tokenAddress(input.tokenA) === null
            || tokenAddress(input.tokenB) === null
            || tokenAddress(input.tokenA) === tokenAddress(input.tokenB)}
          onClick={onReview}
        >
          {isReviewing ? "Reviewing pool…" : "Review pool"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TokenFields({
  config,
  preview: { preview, retry },
  otherAddress,
  label,
  address,
  amount,
  onAddress,
  onAmount,
}: {
  config: GlobalConfig;
  preview: ReturnType<typeof useTokenPreview>;
  otherAddress: string;
  label: string;
  address: string;
  amount: string;
  onAddress: (value: string) => void;
  onAmount: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-foreground/10 p-4">
      <h2 className="font-heading font-semibold">{label}</h2>
      <TokenAddressCombobox
        label={label}
        value={address}
        otherAddress={otherAddress}
        discovery={config.tokenDiscovery}
        onChange={onAddress}
      />
      {preview === null ? null : (
        <div role="status" aria-live="polite" className="flex min-w-0 flex-col gap-2 break-all text-sm">
          {preview.status === "pending" ? "Loading live token metadata..."
            : preview.status === "ready" ? (
              <>
                <span>Live name: {preview.metadata.name?.trim() || <BlockchainIdentifier kind="address" value={address} label="Token address" />}</span>
                <span>Live symbol: {preview.metadata.symbol?.trim() || <BlockchainIdentifier kind="address" value={address} label="Token address" />}</span>
                <span>Decimals: {preview.metadata.decimals ?? "unavailable"}</span>
                <span className="text-muted-foreground">
                  Informational only. Review rereads live state before creation.
                </span>
              </>
            ) : (
              <>
                <span>{preview.networkMismatch
                  ? "RPC network mismatch. Check the connection and retry."
                  : "Live token metadata is unavailable. The address is still editable."}</span>
                <Button type="button" size="sm" variant="outline" onClick={retry}>
                  Retry {label} metadata
                </Button>
              </>
            )}
        </div>
      )}
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
            label={<TokenSymbol symbol={review.token0.symbol} address={review.token0.addressHex} />}
            value={formatAmount(review.token0.amount, review.token0.decimals)}
          />
          <ReviewRow
            label={<TokenSymbol symbol={review.token1.symbol} address={review.token1.addressHex} />}
            value={formatAmount(review.token1.amount, review.token1.decimals)}
          />
          <ReviewRow label="Initial ratio" value={<>{formatAmount(
            review.token0.amount,
            review.token0.decimals,
          )} <TokenSymbol symbol={review.token0.symbol} address={review.token0.addressHex} /> : {formatAmount(
            review.token1.amount,
            review.token1.decimals,
          )} <TokenSymbol symbol={review.token1.symbol} address={review.token1.addressHex} /></>} />
          <ReviewRow
            label="Estimated LP before lock"
            value={`${review.initialLiquidity} base units`}
          />
          <ReviewRow label="Funding minimum" value={`${review.fundingMinimum} HOG base units per contract`} />
          <ReviewRow label="Recommended funding" value={`${review.fundingPerContract} HOG base units per contract`} />
        </dl>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="font-medium">Atomic factory funding</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The factory recommends {review.totalFunding} HOG base units across
              the LP token, handler, and driver. The app will approve
              {" "}{review.fundingApprovalDifference} additional base units, then
              create and fund all three contracts atomically.
            </p>
          </div>
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

function ReviewRow({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
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
  const canContinueRace = workflow.status === "race" && workflow.pool !== null;
  const needsFundingCleanup = workflow.status === "failed"
    && workflow.steps.approveFunding.status === "committed"
    && workflow.steps.createPool.status === "failed";
  const terminal = ["executed", "failed", "archived"].includes(workflow.status)
    || (workflow.status === "race" && !canContinueRace);
  const actionLabel = blocking
    ? "Check transaction and continue"
    : workflow.status === "queued"
      ? workflow.steps.crank.status === "committed"
        ? "Retry queue processing"
        : "Process liquidity queue"
      : canContinueRace
        ? "Remove funding allowance and continue"
        : needsFundingCleanup
          ? "Remove factory funding allowance"
          : "Continue creation";
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle asChild><h2>Creation progress</h2></CardTitle>
            <CardDescription>
              {formatAmount(BigInt(workflow.token0.amount), workflow.token0.decimals)} <TokenSymbol symbol={workflow.token0.symbol} address={workflow.token0.address} />
              {" / "}{formatAmount(BigInt(workflow.token1.amount), workflow.token1.decimals)} <TokenSymbol symbol={workflow.token1.symbol} address={workflow.token1.address} />.
              {" "}Factory funding: {workflow.totalFunding} HOG base units
              ({workflow.fundingPerContract} per contract; minimum {workflow.fundingMinimum}).
            </CardDescription>
            {workflow.executionMode === "batch" ? (
              <CardDescription>Pool creation, approvals, and liquidity submission share one transaction. Queue processing is separate.</CardDescription>
            ) : null}
          </div>
          <Badge variant="outline">{workflow.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="flex flex-wrap gap-3 text-sm">
          <BlockchainIdentifier kind="address" value={workflow.token0.address} label="Token 0 address" />
          <BlockchainIdentifier kind="address" value={workflow.token1.address} label="Token 1 address" />
        </div>
        {workflow.executionMode === "batch" ? (
          <div className="grid gap-1 text-sm">
            <span className="font-medium">Creation batch</span>
            {workflow.steps.createPool.transactionHash ? (
              <BlockchainIdentifier kind="transaction" value={workflow.steps.createPool.transactionHash} label="Creation batch transaction hash" />
            ) : null}
            {workflow.steps.createPool.message ? <p className="text-muted-foreground">{workflow.steps.createPool.message}</p> : null}
          </div>
        ) : null}
        <CreationSteps
          label="Pool contract creation"
          names={creationStepOrder.slice(0, 2)}
          workflow={workflow}
        />
        <CreationSteps
          label="Initial liquidity"
          names={creationStepOrder.slice(2)}
          workflow={workflow}
        />
      </CardContent>
      {terminal && !needsFundingCleanup ? (
        <CardFooter>
          <Button disabled={isRunning} variant="outline" onClick={onStartOver}>Start another pool</Button>
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

function CreationSteps({
  label,
  names,
  workflow,
}: {
  label: string;
  names: readonly CreationStepName[];
  workflow: CreationWorkflow;
}) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">{label}</h3>
      <ol aria-label={`${label} stages`} className="grid gap-3">
        {names.map((name) => {
          const step = workflow.steps[name];
          return (
            <li className="flex items-start gap-3" key={name}>
              <StepIcon status={step.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{stepLabels[name]}</span>
                  <span className="text-xs text-muted-foreground">{step.status}</span>
                </div>
                {step.message === null || (workflow.executionMode === "batch" && name !== "crank") ? null : (
                  <p className="mt-1 text-sm text-muted-foreground">{step.message}</p>
                )}
                {step.transactionHash === null || (workflow.executionMode === "batch" && name !== "crank") ? null : (
                  <div className="mt-1 text-xs">
                    <BlockchainIdentifier
                      kind="transaction"
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
    </section>
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
  cleanup: ReturnType<typeof loadAllowanceCleanup>;
  error: string | null;
} {
  try {
    const workflows = loadAccountCreationWorkflows(config);
    const current = workflows
      .filter((workflow) => isRecoverableCreationWorkflow(
        workflow,
        toHex0x(config.factoryAddress),
      ))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
    return { workflows, current, cleanup: loadAllowanceCleanup(config), error: null };
  } catch {
    return {
      workflows: [],
      current: null,
      cleanup: null,
      error:
        "Stored account creation workflows could not be loaded safely. Clear or repair local site data before signing.",
    };
  }
}

function isRecoverableCreationWorkflow(
  workflow: CreationWorkflow,
  factoryAddress: string,
): boolean {
  return workflow.factoryAddress === factoryAddress
    && (workflow.status === "active"
      || workflow.status === "queued"
      || workflow.status === "race"
      || (workflow.status === "failed"
        && workflow.steps.approveFunding.status === "committed"
        && workflow.steps.createPool.status === "failed"));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Pool creation could not continue";
}

async function readFactoryAllowance(
  config: GlobalConfig,
  client: CoreGroundhogClient,
): Promise<{ value: bigint; height: bigint }> {
  const token = createErc20ReadAdapter({
    client,
    contract: config.nativeHogAddress,
    caller: config.accountAddress,
  });
  const view = await token.allowance(config.accountAddress, config.factoryAddress);
  return { value: view.value, height: view.height };
}
