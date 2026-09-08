import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
  RocketIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
} from "react-router-dom";

import {
  BlockchainIdentifier,
  ExplorerProvider,
  type IdentifierKind,
} from "@/components/blockchain-identifier";
import { AppHeader } from "@/components/app-header";
import { CopyIdentifierButton } from "@/components/copy-identifier-button";
import { ProviderApp, WalletControls } from "@/components/provider-wallet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfigurationError, loadConfig, type AppConfig } from "@/config";
import {
  readCreatedTokens,
  reviewFactory,
  type CreatedToken,
  type FactoryReview,
} from "@/contracts/launchpad-client";
import { userErrorMessage } from "@/errors";
import { createReadClient } from "@/groundhog/client";
import { runWorkflow } from "@/launch/executor";
import { formatUnits, parseTokenDraft, type TokenDraft } from "@/launch/form";
import { createAmmPoolLink } from "@/launch/swap-link";
import {
  canDiscardInvalidStoredWorkflow,
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  withWorkflowLock,
  withWorkflowSessionLock,
  workflowIntent,
  workflowStorageKey,
  WorkflowStorageError,
  type LaunchWorkflow,
} from "@/launch/workflow";
import { unavailableWriteBoundary } from "@/transactions/write-boundary";
import type { WriteBoundary } from "@/transactions/write-boundary";
import {
  getRegistryStatus,
  getRegistryTokens,
  requestRegistrySync,
  type RegistrySort,
  type RegistryStatus,
  type RegistryTokenPage,
} from "@/registry/client";
import {
  enrichTokenBalances,
  registryTokenToCreatedToken,
} from "@/registry/tokens";

export function App() {
  let base: AppConfig;
  try {
    base = loadConfig(import.meta.env);
  } catch (error) {
    return (
      <ErrorPage
        message={
          error instanceof ConfigurationError
            ? error.message
            : "Application configuration is invalid"
        }
      />
    );
  }
  return (
    <TooltipProvider>
      <BrowserRouter>
        <ProviderApp base={base} />
      </BrowserRouter>
    </TooltipProvider>
  );
}

export function LaunchpadRoutes({
  config,
  writer = unavailableWriteBoundary,
  readOnly = true,
}: {
  config: AppConfig;
  writer?: WriteBoundary;
  readOnly?: boolean;
}) {
  const client = useMemo(() => createReadClient(config), [config]);
  return (
    <ExplorerProvider explorerUrl={config.explorerUrl}>
      <Header readOnly={readOnly} />
      <Routes>
        <Route
          path="/"
          element={<Navigate to={readOnly ? "/tokens" : "/create"} replace />}
        />
        <Route
          path="/create"
          element={
            readOnly ? (
              <ConnectPrompt />
            ) : (
              <CreatePage
                config={config}
                client={client}
                writer={writer}
                writesSupported={!readOnly}
              />
            )
          }
        />
        <Route
          path="/tokens"
          element={
            <TokensPage
              key="all"
              config={config}
              client={client}
              scope="all"
              readOnly={readOnly}
            />
          }
        />
        <Route
          path="/my-tokens"
          element={
            readOnly ? (
              <ConnectPrompt />
            ) : (
              <TokensPage
                key="mine"
                config={config}
                client={client}
                scope="mine"
                readOnly={readOnly}
              />
            )
          }
        />
        <Route
          path="*"
          element={<Navigate to={readOnly ? "/tokens" : "/create"} replace />}
        />
      </Routes>
    </ExplorerProvider>
  );
}

export function Header({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <AppHeader
      product="Token Launchpad"
      homeHref={readOnly ? "/tokens" : "/create"}
      navigation={
        <>
          <NavLink className="app-nav-link" to="/tokens">
            Tokens
          </NavLink>
          <NavLink className="app-nav-link" to="/my-tokens">
            My Tokens
          </NavLink>
          <NavLink className="app-nav-link" to="/create">
            Create Token
          </NavLink>
        </>
      }
      actions={<WalletControls />}
    />
  );
}

function ConnectPrompt() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Connect your wallet</EmptyTitle>
          <EmptyDescription>
            Connect a wallet above to create tokens or view your tokens. Public
            token browsing does not require a wallet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}

const initialDraft: TokenDraft = {
  name: "",
  symbol: "",
  decimals: "7",
  supply: "1000000",
};
export function CreatePage({
  config,
  client,
  writer,
  requestSync = requestRegistrySync,
  writesSupported = true,
}: {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
  writer: WriteBoundary;
  requestSync?: typeof requestRegistrySync;
  writesSupported?: boolean;
}) {
  const storageKey = workflowStorageKey(config);
  const [initialWorkflow] = useState<{
    workflow: LaunchWorkflow | null;
    error: string | null;
    invalidDiscardable: boolean;
  }>(() => {
    try {
      return {
        workflow: loadWorkflow(localStorage, storageKey),
        error: null,
        invalidDiscardable: false,
      };
    } catch (error) {
      return {
        workflow: null,
        error: userErrorMessage(
          error,
          "The saved launch workflow could not be read",
        ),
        invalidDiscardable: canDiscardInvalidStoredWorkflow(
          localStorage,
          storageKey,
        ),
      };
    }
  });
  const [storageError, setStorageError] = useState(initialWorkflow.error);
  const [workflow, setWorkflow] = useState(initialWorkflow.workflow);
  const [draft, setDraft] = useState<TokenDraft>(() =>
    workflow
      ? {
          name: workflow.token.name,
          symbol: workflow.token.symbol,
          decimals: workflow.token.decimals.toString(),
          supply: formatUnits(
            BigInt(workflow.token.initialSupply),
            workflow.token.decimals,
          ),
        }
      : initialDraft,
  );
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<FactoryReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualProcessing, setManualProcessing] = useState(false);
  const reviewGeneration = useRef(0);
  const reviewing = useRef(false);
  useEffect(() => {
    reviewing.current = false;
    setLoading(false);
    return () => {
      reviewGeneration.current += 1;
    };
  }, [client, config]);
  const parsed = parseTokenDraft(draft);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      reviewing.current ||
      loading ||
      workflow ||
      storageError ||
      !writesSupported
    )
      return;
    setSubmitted(true);
    setError(null);
    if (!parsed.value) return;
    const token = parsed.value;
    const generation = ++reviewGeneration.current;
    reviewing.current = true;
    setLoading(true);
    try {
      const result = await withWorkflowLock(config, async () => {
        if (loadWorkflow(localStorage, storageKey) !== null) {
          throw new Error(
            "Another tab created a launch workflow. Reload before continuing.",
          );
        }
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        const nextReview = await reviewFactory(client, config, nonce);
        if (generation !== reviewGeneration.current) return null;
        const nextWorkflow = createWorkflow(config, token, nonce, nextReview);
        saveWorkflow(localStorage, storageKey, nextWorkflow);
        return { nextReview, nextWorkflow };
      });
      if (!result || generation !== reviewGeneration.current) return;
      setReview(result.nextReview);
      setWorkflow(result.nextWorkflow);
    } catch (reason) {
      if (generation !== reviewGeneration.current) return;
      setError(
        userErrorMessage(
          reason,
          "The configured token factory could not be verified.",
        ),
      );
    } finally {
      if (generation === reviewGeneration.current) {
        reviewing.current = false;
        setLoading(false);
      }
    }
  }
  async function advance() {
    if (!workflow) return;
    setLoading(true);
    setError(null);
    try {
      const next = await runWorkflow({
        config,
        client,
        writer,
        automatic: !manualProcessing,
        onUpdate: setWorkflow,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
        ...(workflow.funding.status === "signing"
          ? { confirmUnsignedStep: "funding" as const }
          : workflow.creation.status === "signing"
            ? { confirmUnsignedStep: "creation" as const }
            : {}),
      });
      setReview(null);
      setWorkflow(next);
      if (
        config.registryEnabled &&
        workflow.creation.status !== "committed" &&
        next.creation.status === "committed"
      ) {
        void requestSync(config).catch(() => undefined);
      }
    } catch (reason) {
      setError(userErrorMessage(reason, "The launch could not continue."));
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    if (workflow && !canDiscardWorkflow(workflow)) {
      setError("A workflow with transaction evidence cannot be discarded.");
      return;
    }
    setLoading(true);
    try {
      await withWorkflowLock(config, async () => {
        if (workflow === null) {
          try {
            if (loadWorkflow(localStorage, storageKey) !== null) {
              throw new Error(
                "This launch changed in another tab. Reload before clearing it.",
              );
            }
          } catch (reason) {
            if (!(reason instanceof WorkflowStorageError)) throw reason;
          }
          if (!canDiscardInvalidStoredWorkflow(localStorage, storageKey)) {
            throw new Error(
              "The invalid saved workflow may contain transaction evidence and cannot be discarded safely.",
            );
          }
          localStorage.removeItem(storageKey);
          return;
        }
        const stored = loadWorkflow(localStorage, storageKey);
        if (
          stored === null ||
          stored.id !== workflow?.id ||
          stored.revision !== workflow.revision
        ) {
          throw new Error(
            "This launch changed in another tab. Reload before clearing it.",
          );
        }
        localStorage.removeItem(storageKey);
      });
      setWorkflow(null);
      setReview(null);
      setDraft(initialDraft);
      setSubmitted(false);
      setError(null);
      setStorageError(null);
    } catch (reason) {
      setStorageError(
        userErrorMessage(
          reason,
          "The saved launch workflow could not be cleared.",
        ),
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8 max-w-2xl">
        <h1 className="app-page-title">Token Launchpad</h1>
        <p className="mt-2 text-base text-muted-foreground">
          Create a token on Thruput. Review the details, then launch.
        </p>
      </div>
      {error || storageError ? (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Launch unavailable</AlertTitle>
          <AlertDescription>{error ?? storageError}</AlertDescription>
        </Alert>
      ) : null}
      {storageError && initialWorkflow.invalidDiscardable ? (
        <Button
          className="mb-6"
          variant="outline"
          onClick={reset}
          disabled={loading || !writesSupported}
        >
          Discard invalid saved workflow
        </Button>
      ) : null}
      {submitted && !parsed.value ? (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Check the token details</AlertTitle>
          <AlertDescription>
            Correct the highlighted fields before reviewing this launch.
          </AlertDescription>
        </Alert>
      ) : null}
      {!writesSupported ? (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Transactions unavailable</AlertTitle>
          <AlertDescription>
            This browser cannot safely serialize launch transactions.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[23fr_17fr]">
        <Card>
          <CardHeader>
            <CardTitle>Token details</CardTitle>
            <CardDescription>
              Metadata is permanent after launch.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit}>
              <FieldGroup>
                {(
                  [
                    ["symbol", "Symbol", "e.g. CRED"],
                    ["name", "Token name", "e.g. Community Credits"],
                    ["decimals", "Decimals", "7"],
                    ["supply", "Initial supply", "1000000"],
                  ] as const
                ).map(([key, label, placeholder]) => {
                  const hasError = submitted && !!parsed.errors[key];
                  const descriptionId = `${key}-description`;
                  const errorId = `${key}-error`;
                  return (
                    <Field key={key} data-invalid={hasError}>
                      <FieldLabel htmlFor={key}>{label}</FieldLabel>
                      <Input
                        id={key}
                        name={key}
                        value={draft[key]}
                        placeholder={placeholder}
                        type={key === "decimals" ? "number" : "text"}
                        autoComplete="off"
                        inputMode={
                          key === "decimals" || key === "supply"
                            ? "decimal"
                            : "text"
                        }
                        aria-describedby={
                          hasError
                            ? `${descriptionId} ${errorId}`
                            : descriptionId
                        }
                        aria-invalid={hasError}
                        disabled={loading || workflow !== null}
                        onChange={(event) => {
                          if (reviewing.current || workflow) return;
                          setReview(null);
                          setDraft({ ...draft, [key]: event.target.value });
                        }}
                      />
                      <FieldDescription id={descriptionId}>
                        {key === "supply"
                          ? "Assigned to the active wallet."
                          : key === "decimals"
                            ? "Choose 0 to 18."
                            : "Required metadata."}
                      </FieldDescription>
                      {hasError ? (
                        <FieldError id={errorId}>
                          {parsed.errors[key]}
                        </FieldError>
                      ) : null}
                    </Field>
                  );
                })}
                {workflow === null ? (
                  <Button
                    className="min-h-12"
                    type="submit"
                    disabled={
                      loading || storageError !== null || !writesSupported
                    }
                  >
                    {loading ? "Reviewing factory..." : "Review launch"}
                    <ArrowRightIcon data-icon="inline-end" />
                  </Button>
                ) : null}
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <ReviewCard
          config={config}
          draft={draft}
          review={review}
          workflow={workflow}
          loading={loading}
          manualProcessing={manualProcessing}
          onAdvance={advance}
          onReset={reset}
          writesSupported={writesSupported}
        />
      </div>
      <Field
        orientation="horizontal"
        data-disabled={loading}
        className="mt-6 px-1"
      >
        <FieldContent>
          <FieldTitle>Manual transaction processing</FieldTitle>
          <FieldDescription>
            Review and submit the funding and creation transactions separately.
          </FieldDescription>
        </FieldContent>
        <Switch
          aria-label="Manual transaction processing"
          checked={manualProcessing}
          disabled={loading}
          onCheckedChange={setManualProcessing}
        />
      </Field>
    </main>
  );
}

export function ReviewCard({
  config,
  draft,
  review,
  workflow,
  loading,
  manualProcessing,
  onAdvance,
  onReset,
  writesSupported,
}: {
  config: AppConfig;
  draft: TokenDraft;
  review: FactoryReview | null;
  workflow: LaunchWorkflow | null;
  loading: boolean;
  manualProcessing: boolean;
  onAdvance: () => void;
  onReset: () => void;
  writesSupported: boolean;
}) {
  if (workflow) {
    draft = {
      name: workflow.token.name,
      symbol: workflow.token.symbol,
      decimals: workflow.token.decimals.toString(),
      supply: formatUnits(
        BigInt(workflow.token.initialSupply),
        workflow.token.decimals,
      ),
    };
  }
  const parsed = parseTokenDraft(draft).value;
  const ammPoolLink = createAmmPoolLink(config.swapAppUrl, workflow);
  return (
    <ExplorerProvider explorerUrl={config.explorerUrl}>
      <Card className="h-fit lg:sticky lg:top-6">
        <CardHeader>
          <div className="mb-3 grid size-14 place-items-center rounded-lg border bg-muted font-mono text-xl font-medium">
            {draft.symbol.trim().slice(0, 2).toUpperCase() || "?"}
          </div>
          <CardTitle>{draft.symbol.trim().toUpperCase() || "SYMBOL"}</CardTitle>
          <CardDescription>
            {draft.name.trim() || "Your token"} · {draft.decimals || "0"}{" "}
            decimals
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Detail
            label="Initial supply"
            value={
              parsed ? formatUnits(parsed.initialSupply, parsed.decimals) : "-"
            }
          />
          <Detail
            label="Administrator"
            value={
              <BlockchainIdentifier
                kind="address"
                value={toAddressHex(config.accountAddress)}
              />
            }
          />
          <Detail
            label="Initial holder"
            value={
              <BlockchainIdentifier
                kind="address"
                value={toAddressHex(config.accountAddress)}
              />
            }
          />
          {review?.predictedAddressHex || workflow?.predictedAddressHex ? (
            <IdentifierDetail
              label="Predicted address"
              kind="address"
              value={
                review?.predictedAddressHex ?? workflow!.predictedAddressHex
              }
            />
          ) : (
            <Detail label="Predicted address" value="Available after review" />
          )}
          <Detail
            label="Factory fee"
            value={review || workflow ? "0 HOG" : "-"}
          />
          <Detail
            label="Required reserve"
            value={
              review
                ? `${review.config.required_token_funding} HOG units`
                : workflow
                  ? `${workflow.requiredTokenFunding} HOG units`
                  : "-"
            }
          />
          <Detail
            label="Funding transfer"
            value={
              review
                ? `${review.fundingAmount} HOG units`
                : workflow
                  ? `${workflow.plannedFundingAmount} HOG units`
                  : "-"
            }
          />
          {review?.fundingShortfall ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Insufficient HOG</AlertTitle>
              <AlertDescription>
                This wallet needs at least {review.fundingShortfall.toString()}{" "}
                more HOG for token funding. Execution costs may require
                additional HOG.
              </AlertDescription>
            </Alert>
          ) : null}
          {workflow ? (
            <>
              <IdentifierDetail
                label="Application nonce"
                value={workflow.nonceHex}
              />
              <IdentifierDetail
                label="Implementation hash"
                value={workflow.reviewedTokenCodeHashHex}
              />
              <IdentifierDetail
                label="Native token"
                kind="address"
                value={workflow.reviewedNativeTokenHex}
              />
            </>
          ) : null}
          {workflow?.funding.hash ? (
            <IdentifierDetail
              label="Funding transaction"
              kind="transaction"
              value={workflow.funding.hash}
            />
          ) : null}
          {workflow?.creation.hash ? (
            <IdentifierDetail
              label="Creation transaction"
              kind="transaction"
              value={workflow.creation.hash}
            />
          ) : null}
          {workflow?.creationBlock ? (
            <Detail label="Creation block" value={workflow.creationBlock} />
          ) : null}
          {workflow?.verification.totalSupply ? (
            <Detail
              label="Verified total supply"
              value={formatUnits(
                BigInt(workflow.verification.totalSupply),
                workflow.token.decimals,
              )}
            />
          ) : null}
          {workflow?.verification.holderBalance ? (
            <Detail
              label="Verified holder balance"
              value={formatUnits(
                BigInt(workflow.verification.holderBalance),
                workflow.token.decimals,
              )}
            />
          ) : null}
          {workflow?.createdAddressHex ? (
            <IdentifierDetail
              label="Token contract"
              kind="address"
              value={workflow.createdAddressHex}
            />
          ) : null}
          {workflow ? (
            <div className="space-y-3" aria-live="polite">
              <ProgressStep
                label="Fund token address"
                step={workflow.funding}
              />
              <ProgressStep
                label="Create and initialize token"
                step={workflow.creation}
              />
              <ProgressStatus
                label="Verify committed token"
                status={
                  workflow.creation.status !== "committed"
                    ? "pending"
                    : workflow.verification.status === "complete"
                      ? "complete"
                      : "incomplete"
                }
              />
              {workflow.error ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Launch paused</AlertTitle>
                  <AlertDescription>{workflow.error}</AlertDescription>
                </Alert>
              ) : null}
              {workflow.creation.status === "committed" ? (
                <>
                  <Alert>
                    <CheckCircle2Icon />
                    <AlertTitle>Token created</AlertTitle>
                    <AlertDescription>
                      {workflow.verification.status === "complete"
                        ? "Receipt, events, metadata, supply, and holder balance match this launch."
                        : "The receipt and creation events match this launch."}
                    </AlertDescription>
                  </Alert>
                  {workflow.verification.status === "incomplete" ? (
                    <>
                      <Alert>
                        <AlertCircleIcon />
                        <AlertTitle>Verification incomplete</AlertTitle>
                        <AlertDescription>
                          {workflow.verification.message}
                        </AlertDescription>
                      </Alert>
                      <Button
                        className="min-h-12 w-full"
                        onClick={onAdvance}
                        disabled={loading || !writesSupported}
                        variant="outline"
                      >
                        {loading ? "Verifying token..." : "Retry verification"}
                        <RefreshCwIcon />
                      </Button>
                    </>
                  ) : null}
                  <Button
                    className="min-h-12 w-full"
                    variant="outline"
                    onClick={onReset}
                    disabled={!writesSupported}
                  >
                    Create another token
                  </Button>
                  <Button className="min-h-12 w-full" variant="outline" asChild>
                    <Link to="/my-tokens">View my tokens</Link>
                  </Button>
                  {ammPoolLink ? (
                    <Button
                      className="min-h-12 w-full"
                      variant="outline"
                      asChild
                    >
                      <a href={ammPoolLink}>Create AMM Pool</a>
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <Button
                    className="min-h-12 w-full"
                    onClick={onAdvance}
                    disabled={loading || !writesSupported}
                    variant={
                      actionLabel(workflow, manualProcessing) ===
                        "Create token" ||
                      actionLabel(workflow, manualProcessing) === "Launch token"
                        ? "default"
                        : "outline"
                    }
                  >
                    {loading
                      ? loadingActionLabel(workflow, manualProcessing)
                      : actionLabel(workflow, manualProcessing)}
                    <ArrowRightIcon />
                  </Button>
                  {canDiscardWorkflow(workflow) ? (
                    <Button
                      className="min-h-12 w-full"
                      variant="outline"
                      onClick={onReset}
                      disabled={loading || !writesSupported}
                    >
                      Edit token details
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : review ? (
            <Alert>
              <CheckCircle2Icon />
              <AlertTitle>Factory verified</AlertTitle>
              <AlertDescription>
                The address and zero-fee factory configuration are ready.
                Continue to fund the predicted address.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </ExplorerProvider>
  );
}

function ProgressStep({
  label,
  step,
}: {
  label: string;
  step: LaunchWorkflow["funding"];
}) {
  const status =
    step.status === "idle"
      ? "pending"
      : step.status === "signing" || step.status === "pending"
        ? "active"
        : step.status === "committed"
          ? "complete"
          : step.status;
  return (
    <div className="space-y-1">
      <ProgressStatus label={label} status={status} />
      {step.hash ? (
        <p className="px-3 font-mono text-xs text-muted-foreground">
          <BlockchainIdentifier kind="transaction" value={step.hash} />
        </p>
      ) : null}
    </div>
  );
}

function ProgressStatus({ label, status }: { label: string; status: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span>{label}</span>
      <Badge variant={status === "complete" ? "secondary" : "outline"}>
        {status}
      </Badge>
    </div>
  );
}

function IdentifierDetail({
  label,
  value,
  kind = "identifier",
}: {
  label: string;
  value: string;
  kind?: IdentifierKind;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex min-h-12 items-center justify-between gap-2 rounded-md border px-3">
        <BlockchainIdentifier value={value} kind={kind} />
        <CopyIdentifierButton value={value} label={`Copy ${label}: ${value}`} />
      </div>
    </div>
  );
}

function nextActionLabel(workflow: LaunchWorkflow): string {
  if (workflow.funding.status !== "committed") {
    if (workflow.funding.status === "signing") {
      return "Confirm no funding was signed";
    }
    if (workflow.funding.status === "failed") return "Retry funding";
    return workflow.funding.hash
      ? "Check funding transaction"
      : "Fund token address";
  }
  if (workflow.creation.status === "signing") {
    return "Confirm no creation was signed";
  }
  if (workflow.creation.status === "failed") return "Retry creation";
  return workflow.creation.hash ? "Check creation transaction" : "Create token";
}

function canDiscardWorkflow(workflow: LaunchWorkflow): boolean {
  return (
    workflow.creation.status === "committed" ||
    (workflow.funding.status === "idle" &&
      workflow.funding.hash === null &&
      workflow.creation.status === "idle" &&
      workflow.creation.hash === null)
  );
}

function actionLabel(
  workflow: LaunchWorkflow,
  manualProcessing: boolean,
): string {
  if (
    !manualProcessing &&
    workflow.error === null &&
    workflow.funding.status === "idle" &&
    workflow.creation.status === "idle"
  ) {
    return "Launch token";
  }
  return nextActionLabel(workflow);
}

function loadingActionLabel(
  workflow: LaunchWorkflow,
  manualProcessing: boolean,
): string {
  if (
    workflow.funding.status === "signing" ||
    workflow.creation.status === "signing"
  ) {
    return "Confirming recovery...";
  }
  if (
    workflow.funding.status === "pending" ||
    workflow.funding.status === "uncertain" ||
    workflow.creation.status === "pending" ||
    workflow.creation.status === "uncertain"
  ) {
    return "Checking transaction...";
  }
  if (!manualProcessing) return "Launching token...";
  return workflow.funding.status === "committed"
    ? "Creating token..."
    : "Funding token...";
}

export function TokensPage({
  config,
  client,
  scope,
  read = readCreatedTokens,
  registryRead = getRegistryTokens,
  registryStatus = getRegistryStatus,
  registrySync = requestRegistrySync,
  enrichBalances = enrichTokenBalances,
  readOnly = false,
}: {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
  scope: "all" | "mine";
  read?: typeof readCreatedTokens;
  registryRead?: typeof getRegistryTokens;
  registryStatus?: typeof getRegistryStatus;
  registrySync?: typeof requestRegistrySync;
  enrichBalances?: typeof enrichTokenBalances;
  readOnly?: boolean;
}) {
  return (
    <ExplorerProvider explorerUrl={config.explorerUrl}>
      {config.registryEnabled ? (
        <RegistryTokensPage
          config={config}
          client={client}
          scope={scope}
          read={registryRead}
          readStatus={registryStatus}
          requestSync={registrySync}
          enrichBalances={enrichBalances}
          readOnly={readOnly}
        />
      ) : (
        <DirectTokensPage
          config={config}
          client={client}
          scope={scope}
          read={read}
          readOnly={readOnly}
        />
      )}
    </ExplorerProvider>
  );
}

function DirectTokensPage({
  config,
  client,
  scope,
  read,
  readOnly,
}: {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
  scope: "all" | "mine";
  read: typeof readCreatedTokens;
  readOnly: boolean;
}) {
  const [state, setState] = useState<{
    loading: boolean;
    tokens: CreatedToken[];
    error: string | null;
    truncated: boolean;
    historyLimited: boolean;
  }>({
    loading: true,
    tokens: [],
    error: null,
    truncated: false,
    historyLimited: false,
  });
  const requestId = useRef(0);
  function refresh() {
    const currentRequestId = ++requestId.current;
    setState((value) => ({ ...value, loading: true, error: null }));
    void read(client, config, {
      creator: scope === "all" ? null : config.accountAddress,
    }).then(
      (result) => {
        if (currentRequestId !== requestId.current) return;
        setState({ loading: false, error: null, ...result });
      },
      (reason) => {
        if (currentRequestId !== requestId.current) return;
        setState({
          loading: false,
          tokens: [],
          truncated: false,
          historyLimited: false,
          error: userErrorMessage(reason, "Token history is unavailable"),
        });
      },
    );
  }
  useEffect(() => {
    refresh();
    return () => {
      requestId.current += 1;
    };
  }, [client, config, read, scope]);
  const isGlobal = scope === "all";
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="app-page-title">
            {isGlobal ? "Tokens" : "My Tokens"}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {isGlobal
              ? "All tokens launched through this factory."
              : "Factory launches created by this wallet."}
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={state.loading}>
          <RefreshCwIcon />
          Refresh
        </Button>
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>History unavailable</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : state.loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : state.tokens.length === 0 && !state.historyLimited ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RocketIcon />
            </EmptyMedia>
            <EmptyTitle>No tokens yet</EmptyTitle>
            <EmptyDescription>
              {isGlobal
                ? "No tokens have been launched through this factory."
                : "Launch your first standard token from this wallet."}
            </EmptyDescription>
          </EmptyHeader>
          {!readOnly ? (
            <Button asChild>
              <Link to="/create">Create token</Link>
            </Button>
          ) : null}
        </Empty>
      ) : (
        <>
          <TokenCards tokens={state.tokens} connected={!readOnly} />
          {!readOnly && state.tokens.some(({ readError }) => readError) ? (
            <Alert className="mt-4">
              <AlertCircleIcon />
              <AlertTitle>Some current balances are unavailable</AlertTitle>
              <AlertDescription>
                Factory event data is shown where token views could not be read.
              </AlertDescription>
            </Alert>
          ) : null}
          {state.truncated ? (
            <Alert className="mt-4">
              <AlertTitle>Showing the newest 100 launches</AlertTitle>
              <AlertDescription>
                Older factory history is not included.
              </AlertDescription>
            </Alert>
          ) : null}
          {state.historyLimited ? (
            <Alert className="mt-4">
              <AlertCircleIcon />
              <AlertTitle>Older launch history is unavailable</AlertTitle>
              <AlertDescription>
                The event index no longer retains the full factory history.
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      )}
    </main>
  );
}

const REGISTRY_PAGE_SIZE = 20;
const MAX_REGISTRY_OFFSET = 10_000;
const REGISTRY_STATUS_POLL_MS = 1_000;

function RegistryTokensPage({
  config,
  client,
  scope,
  read,
  readStatus,
  requestSync,
  enrichBalances,
  readOnly,
}: {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
  scope: "all" | "mine";
  read: typeof getRegistryTokens;
  readStatus: typeof getRegistryStatus;
  requestSync: typeof requestRegistrySync;
  enrichBalances: typeof enrichTokenBalances;
  readOnly: boolean;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<RegistrySort>("newest");
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncRequestKey, setSyncRequestKey] = useState(0);
  const [page, setPage] = useState<RegistryTokenPage | null>(null);
  const [tokens, setTokens] = useState<CreatedToken[]>([]);
  const [status, setStatus] = useState<RegistryStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const asOfBlock = useRef<string | undefined>(undefined);
  const activeRequest = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const syncRequestId = useRef(0);

  useEffect(() => {
    if (search === debouncedSearch) return;
    const timeout = window.setTimeout(() => {
      setOffset(0);
      asOfBlock.current = undefined;
      setDebouncedSearch(search);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [debouncedSearch, search]);

  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller;
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setError(null);
    const query = {
      ...(debouncedSearch === "" ? {} : { q: debouncedSearch }),
      ...(scope === "mine"
        ? { creator: toAddressHex(config.accountAddress) }
        : {}),
      sort,
      limit: REGISTRY_PAGE_SIZE,
      offset,
      ...(asOfBlock.current === undefined
        ? {}
        : { asOfBlock: asOfBlock.current }),
    };
    void read(config, query, controller.signal).then(
      (result) => {
        if (currentRequestId !== requestId.current) return;
        const metadata = result.tokens.map(registryTokenToCreatedToken);
        setPage(result);
        setTokens(metadata);
        asOfBlock.current ??= result.asOfBlock;
        setLoading(false);
        if (readOnly) return;
        void enrichBalances(client, config, metadata, controller.signal).then(
          (enriched) => {
            if (currentRequestId === requestId.current) setTokens(enriched);
          },
          () => undefined,
        );
      },
      (reason) => {
        if (currentRequestId !== requestId.current) return;
        setPage(null);
        setTokens([]);
        setLoading(false);
        setError(userErrorMessage(reason, "The token registry is unavailable"));
      },
    );
    return () => {
      controller.abort();
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        requestId.current += 1;
      }
    };
  }, [
    client,
    config,
    debouncedSearch,
    enrichBalances,
    offset,
    read,
    readStatus,
    refreshKey,
    readOnly,
    scope,
    sort,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    const currentSyncRequestId = ++syncRequestId.current;
    let pollTimer: number | undefined;
    let observedSyncing = false;

    function isCurrent(): boolean {
      return currentSyncRequestId === syncRequestId.current;
    }
    function refreshCompletedSync(): void {
      asOfBlock.current = undefined;
      setOffset(0);
      setRefreshKey((value) => value + 1);
    }
    function consumeStatus(
      result: RegistryStatus,
      refreshIfIdle: boolean,
    ): void {
      if (!isCurrent()) return;
      setStatus(result);
      setStatusError(false);
      if (result.syncing) {
        observedSyncing = true;
        pollTimer = window.setTimeout(pollStatus, REGISTRY_STATUS_POLL_MS);
      } else if (observedSyncing || refreshIfIdle) {
        refreshCompletedSync();
      }
    }
    async function pollStatus(): Promise<void> {
      try {
        consumeStatus(await readStatus(config, controller.signal), false);
      } catch {
        if (!isCurrent() || controller.signal.aborted) return;
        setStatusError(true);
        pollTimer = window.setTimeout(pollStatus, REGISTRY_STATUS_POLL_MS);
      }
    }
    async function hintSync(): Promise<void> {
      try {
        consumeStatus(await requestSync(config, controller.signal), true);
      } catch {
        if (!isCurrent() || controller.signal.aborted) return;
        try {
          consumeStatus(await readStatus(config, controller.signal), false);
        } catch {
          if (!isCurrent() || controller.signal.aborted) return;
          setStatus(null);
          setStatusError(true);
        }
      }
    }

    void hintSync();
    return () => {
      syncRequestId.current += 1;
      controller.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [config, readStatus, requestSync, scope, syncRequestKey]);

  const isGlobal = scope === "all";
  const hasSearch = debouncedSearch.trim() !== "";
  function cancelCurrentRequest() {
    requestId.current += 1;
    activeRequest.current?.abort();
  }
  function resetSnapshot() {
    cancelCurrentRequest();
    setOffset(0);
    asOfBlock.current = undefined;
  }
  function refresh() {
    resetSnapshot();
    setRefreshKey((value) => value + 1);
    setSyncRequestKey((value) => value + 1);
  }
  function changePage(nextOffset: number) {
    cancelCurrentRequest();
    setOffset(nextOffset);
  }
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="app-page-title">
            {isGlobal ? "Tokens" : "My Tokens"}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {isGlobal
              ? "All tokens launched through this factory."
              : "Factory launches created by this wallet."}
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCwIcon />
          Refresh
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field>
          <FieldLabel htmlFor="token-search">Search tokens</FieldLabel>
          <Input
            id="token-search"
            type="search"
            value={search}
            placeholder="Name, symbol, token, or creator"
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="token-sort">Sort by</FieldLabel>
          <select
            id="token-sort"
            className="h-9 w-full rounded-md border border-input bg-muted px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring sm:text-sm pointer-coarse:min-h-12"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as RegistrySort);
              resetSnapshot();
            }}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name</option>
            <option value="symbol">Symbol</option>
          </select>
        </Field>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Registry unavailable</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{error}</span>
            <Button variant="outline" onClick={refresh}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : loading && page === null ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : page?.total === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RocketIcon />
            </EmptyMedia>
            <EmptyTitle>
              {hasSearch ? "No matching tokens" : "No tokens yet"}
            </EmptyTitle>
            <EmptyDescription>
              {hasSearch
                ? "Try a different name, symbol, token address, or creator address."
                : isGlobal
                  ? "No tokens have been launched through this factory."
                  : "Launch your first standard token from this wallet."}
            </EmptyDescription>
          </EmptyHeader>
          {!hasSearch && !readOnly ? (
            <Button asChild>
              <Link to="/create">Create token</Link>
            </Button>
          ) : null}
        </Empty>
      ) : page ? (
        <>
          <div
            className="flex items-center justify-between gap-4 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <p>
              Showing {page.offset + 1}-{page.offset + page.tokens.length} of{" "}
              {page.total}
            </p>
            {loading ? <span>Updating...</span> : null}
          </div>
          <div role="status" aria-live="polite" className="sr-only">
            {readOnly
              ? "Public token metadata loaded"
              : tokens.some(({ balanceLoading }) => balanceLoading)
                ? "Loading current token balances"
                : "Current token balances loaded"}
          </div>
          <TokenCards tokens={tokens} connected={!readOnly} />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={loading || offset === 0}
              onClick={() =>
                changePage(Math.max(0, offset - REGISTRY_PAGE_SIZE))
              }
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={
                loading ||
                !page.hasMore ||
                offset + REGISTRY_PAGE_SIZE > MAX_REGISTRY_OFFSET
              }
              onClick={() => changePage(offset + REGISTRY_PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}
      {status?.syncState === "integrityFault" ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Registry integrity fault</AlertTitle>
          <AlertDescription>
            {status.lastError ??
              "Indexing stopped because registry evidence failed validation. An operator must resolve the fault."}
          </AlertDescription>
        </Alert>
      ) : statusError ||
        status?.syncState === "retrying" ||
        status?.lastError ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Registry sync delayed</AlertTitle>
          <AlertDescription>
            {status?.lastError ??
              "Current tokens are shown, but registry freshness could not be confirmed. Retrying automatically."}
          </AlertDescription>
        </Alert>
      ) : status?.syncState === "syncing" ? (
        <Alert>
          <AlertTitle>Registry is syncing</AlertTitle>
          <AlertDescription>
            New launches may appear after indexing reaches the chain tip.
          </AlertDescription>
        </Alert>
      ) : null}
      {page?.historyLimited || status?.historyLimited ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Older launch history is unavailable</AlertTitle>
          <AlertDescription>
            The registry started after some factory events had left retained
            history, so these results are incomplete.
          </AlertDescription>
        </Alert>
      ) : null}
      {!readOnly && tokens.some(({ readError }) => readError) ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Some current balances are unavailable</AlertTitle>
          <AlertDescription>
            Registry metadata is shown where live token balance views could not
            be read.
          </AlertDescription>
        </Alert>
      ) : null}
    </main>
  );
}

function TokenCards({
  tokens,
  connected,
}: {
  tokens: readonly CreatedToken[];
  connected: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {tokens.map((token) => (
        <Card key={token.addressHex}>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{token.symbol}</CardTitle>
                <CardDescription>
                  {token.name} ·{" "}
                  {token.decimals === null
                    ? "Unsupported decimals"
                    : `${token.decimals} decimals`}
                </CardDescription>
              </div>
              <Badge variant="secondary">Block {token.block.toString()}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Detail
              label="Initial supply"
              value={formatTokenAmount(token.initialSupply, token.decimals)}
            />
            <Detail
              label={connected ? "Your balance" : "Wallet balance"}
              value={
                !connected
                  ? "Connect a wallet"
                  : token.balanceLoading
                    ? "Loading..."
                    : token.balance === null
                      ? "Unavailable"
                      : formatTokenAmount(token.balance, token.decimals)
              }
            />
            <Detail
              label="Administrator"
              value={
                <BlockchainIdentifier
                  kind="address"
                  value={token.administratorHex}
                />
              }
            />
            <div className="flex items-center gap-2 rounded-lg bg-muted p-3 font-mono text-xs">
              <span className="min-w-0 flex-1">
                <BlockchainIdentifier kind="address" value={token.addressHex} />
              </span>
              <CopyIdentifierButton
                variant="ghost"
                label="Copy token address"
                value={token.addressHex}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function toAddressHex(value: ArrayLike<number>): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-3 text-sm last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[65%] break-all text-right font-mono font-medium tabular-nums">
        {value}
      </span>
    </div>
  );
}
function formatTokenAmount(value: bigint, decimals: number | null): string {
  return decimals === null
    ? `${value.toString()} base units`
    : formatUnits(value, decimals);
}
function ErrorPage({ message }: { message: string }) {
  return (
    <>
      <AppHeader product="Token Launchpad" />
      <main className="grid min-h-[calc(100svh-5rem)] place-items-center p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>
              <h1>Configuration required</h1>
            </CardTitle>
            <CardDescription>
              Run the local setup command before starting the launchpad.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Generated configuration is unavailable</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
