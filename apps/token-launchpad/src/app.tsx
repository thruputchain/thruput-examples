import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CopyIcon,
  RefreshCwIcon,
  RocketIcon,
} from "lucide-react";
import { startTransition, useEffect, useMemo, useState } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
} from "react-router-dom";

import {
  DevelopmentWalletContext,
  DevelopmentWalletSwitcher,
} from "@/components/development-wallet-switcher";
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfigurationError, loadConfig, type AppConfig } from "@/config";
import {
  readCreatedTokens,
  reviewFactory,
  type CreatedToken,
  type FactoryReview,
} from "@/contracts/launchpad-client";
import {
  parseDevelopmentPersonas,
  preferenceKey,
  publicPersona,
  type DevelopmentPersonaId,
} from "@/development-personas";
import { createReadClient } from "@/groundhog/client";
import { advanceWorkflow } from "@/launch/executor";
import { formatUnits, parseTokenDraft, type TokenDraft } from "@/launch/form";
import {
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  withWorkflowLock,
  workflowIntent,
  workflowStorageKey,
  type LaunchWorkflow,
} from "@/launch/workflow";
import { createBrowserWriteBoundary } from "@/transactions/local-development-wallet";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { createWalletPortfolioReader } from "@/wallet/portfolio";

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
  let personas: ReturnType<typeof parseDevelopmentPersonas>;
  try {
    personas = parseDevelopmentPersonas(import.meta.env.GROUNDHOG_DEV_PERSONAS);
  } catch (error) {
    return (
      <ErrorPage
        message={
          error instanceof Error
            ? error.message
            : "Development wallets are invalid"
        }
      />
    );
  }
  return (
    <TooltipProvider>
      <BrowserRouter>
        {personas ? (
          <PersonaApp base={base} personas={personas} />
        ) : (
          <LaunchpadRoutes config={base} />
        )}
      </BrowserRouter>
    </TooltipProvider>
  );
}

function PersonaApp({
  base,
  personas,
}: {
  base: AppConfig;
  personas: NonNullable<ReturnType<typeof parseDevelopmentPersonas>>;
}) {
  const key = preferenceKey(base.networkIdHex, base.factoryAddress);
  const [id, setId] = useState(() => sessionStorage.getItem(key));
  const active = personas.find((persona) => persona.id === id) ?? personas[0]!;
  const config = useMemo(
    () => ({ ...base, accountAddress: active.accountAddress }),
    [active.accountAddress, base],
  );
  const client = useMemo(
    () => createReadClient(config.rpcUrl),
    [config.rpcUrl],
  );
  const readPortfolio = useMemo(
    () => createWalletPortfolioReader(client, config),
    [client, config],
  );
  function switchTo(next: DevelopmentPersonaId) {
    sessionStorage.setItem(key, next);
    startTransition(() => setId(next));
  }
  return (
    <DevelopmentWalletContext
      value={{
        active: publicPersona(active),
        personas: personas.map(publicPersona),
        readPortfolio,
        switchTo,
      }}
    >
      <LaunchpadRoutes
        key={active.id}
        config={config}
        walletPrivateKey={active.privateKeyHex}
      />
    </DevelopmentWalletContext>
  );
}

function LaunchpadRoutes({
  config,
  walletPrivateKey,
}: {
  config: AppConfig;
  walletPrivateKey?: string;
}) {
  const client = useMemo(
    () => createReadClient(config.rpcUrl),
    [config.rpcUrl],
  );
  const writer = useMemo(
    () => createBrowserWriteBoundary(config, walletPrivateKey),
    [config, walletPrivateKey],
  );
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<Navigate to="/create" replace />} />
        <Route
          path="/create"
          element={
            <CreatePage config={config} client={client} writer={writer} />
          }
        />
        <Route
          path="/tokens"
          element={<TokensPage config={config} client={client} />}
        />
        <Route path="*" element={<Navigate to="/create" replace />} />
      </Routes>
    </>
  );
}

function Header() {
  return (
    <header className="border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
        <Link
          to="/create"
          className="mr-auto flex items-center gap-2 font-semibold"
        >
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <RocketIcon className="size-4" />
          </span>
          Groundhog Launchpad
        </Link>
        <nav className="flex items-center gap-1" aria-label="Primary">
          <NavLink
            className={({ isActive }) =>
              `rounded-md px-3 py-2 text-sm font-medium ${isActive ? "bg-secondary" : "text-muted-foreground hover:text-foreground"}`
            }
            to="/create"
          >
            Create token
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `rounded-md px-3 py-2 text-sm font-medium ${isActive ? "bg-secondary" : "text-muted-foreground hover:text-foreground"}`
            }
            to="/tokens"
          >
            My tokens
          </NavLink>
        </nav>
        <DevelopmentWalletSwitcher />
      </div>
    </header>
  );
}

const initialDraft: TokenDraft = {
  name: "",
  symbol: "",
  decimals: "7",
  supply: "1000000",
};
function CreatePage({
  config,
  client,
  writer,
}: {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
  writer: WriteBoundary;
}) {
  const storageKey = workflowStorageKey(config);
  const [initialWorkflow] = useState<{
    workflow: LaunchWorkflow | null;
    error: string | null;
  }>(() => {
    try {
      return { workflow: loadWorkflow(localStorage, storageKey), error: null };
    } catch (error) {
      return {
        workflow: null,
        error:
          error instanceof Error
            ? error.message
            : "The saved launch workflow could not be read",
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
  const parsed = parseTokenDraft(draft);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (!parsed.value) return;
    const token = parsed.value;
    setLoading(true);
    try {
      const { nextReview, nextWorkflow } = await withWorkflowLock(
        config,
        async () => {
          if (loadWorkflow(localStorage, storageKey) !== null) {
            throw new Error(
              "Another tab created a launch workflow. Reload before continuing.",
            );
          }
          const nonce = crypto.getRandomValues(new Uint8Array(32));
          const nextReview = await reviewFactory(client, config, nonce);
          const nextWorkflow = createWorkflow(config, token, nonce, nextReview);
          saveWorkflow(localStorage, storageKey, nextWorkflow);
          return { nextReview, nextWorkflow };
        },
      );
      setReview(nextReview);
      setWorkflow(nextWorkflow);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The configured token factory could not be verified.",
      );
    } finally {
      setLoading(false);
    }
  }
  async function advance() {
    if (!workflow) return;
    setLoading(true);
    setError(null);
    try {
      setWorkflow(
        await advanceWorkflow({
          config,
          client,
          writer,
          workflowId: workflow.id,
          workflowRevision: workflow.revision,
          expectedIntent: workflowIntent(workflow),
          ...(workflow.funding.status === "signing"
            ? { confirmUnsignedStep: "funding" as const }
            : workflow.creation.status === "signing"
              ? { confirmUnsignedStep: "creation" as const }
              : {}),
        }),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The launch could not continue.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    if (
      workflow &&
      workflow.creation.status !== "committed" &&
      (workflow.funding.hash !== null || workflow.creation.hash !== null)
    ) {
      setError("A workflow with transaction evidence cannot be discarded.");
      return;
    }
    setLoading(true);
    try {
      await withWorkflowLock(config, async () => {
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
    } catch (reason) {
      setStorageError(
        reason instanceof Error
          ? reason.message
          : "The saved launch workflow could not be cleared.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8 max-w-2xl">
        <Badge variant="outline" className="mb-3">
          Local network
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          Launch a token with a predictable address.
        </h1>
        <p className="mt-4 text-base text-muted-foreground sm:text-lg">
          Define the token, review its reserve, then fund and create it through
          the verified factory.
        </p>
      </div>
      {error || storageError ? (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Factory unavailable</AlertTitle>
          <AlertDescription>{error ?? storageError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1.15fr_.85fr]">
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
                    ["name", "Token name", "e.g. Groundhog Credits"],
                    ["symbol", "Symbol", "e.g. HOGX"],
                    ["decimals", "Decimals", "7"],
                    ["supply", "Initial supply", "1000000"],
                  ] as const
                ).map(([key, label, placeholder]) => (
                  <Field
                    key={key}
                    data-invalid={submitted && !!parsed.errors[key]}
                  >
                    <FieldLabel htmlFor={key}>{label}</FieldLabel>
                    <Input
                      id={key}
                      name={key}
                      value={draft[key]}
                      placeholder={placeholder}
                      inputMode={
                        key === "decimals" || key === "supply"
                          ? "decimal"
                          : "text"
                      }
                      aria-invalid={submitted && !!parsed.errors[key]}
                      disabled={workflow !== null}
                      onChange={(event) => {
                        setReview(null);
                        setDraft({ ...draft, [key]: event.target.value });
                      }}
                    />
                    <FieldDescription>
                      {key === "supply"
                        ? "Assigned to the active wallet."
                        : key === "decimals"
                          ? "Choose 0 to 18."
                          : "Required metadata."}
                    </FieldDescription>
                    {submitted && parsed.errors[key] ? (
                      <FieldError>{parsed.errors[key]}</FieldError>
                    ) : null}
                  </Field>
                ))}
                {workflow === null ? (
                  <Button
                    className="min-h-12"
                    type="submit"
                    disabled={loading || storageError !== null}
                  >
                    {loading ? "Reviewing factory..." : "Review launch"}
                    <ArrowRightIcon />
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
          onAdvance={advance}
          onReset={reset}
        />
      </div>
    </main>
  );
}

function ReviewCard({
  config,
  draft,
  review,
  workflow,
  loading,
  onAdvance,
  onReset,
}: {
  config: AppConfig;
  draft: TokenDraft;
  review: FactoryReview | null;
  workflow: LaunchWorkflow | null;
  loading: boolean;
  onAdvance: () => void;
  onReset: () => void;
}) {
  const parsed = parseTokenDraft(draft).value;
  return (
    <Card className="h-fit lg:sticky lg:top-6">
      <CardHeader>
        <div className="mb-3 grid size-14 place-items-center rounded-2xl bg-accent text-xl font-semibold text-accent-foreground">
          {draft.symbol.trim().slice(0, 2).toUpperCase() || "?"}
        </div>
        <CardTitle>{draft.name.trim() || "Your token"}</CardTitle>
        <CardDescription>
          {draft.symbol.trim().toUpperCase() || "SYMBOL"} ·{" "}
          {draft.decimals || "0"} decimals
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
          label="Administrator and holder"
          value={short(config.accountAddress)}
        />
        <Detail
          label="Predicted address"
          value={
            review?.predictedAddressHex ??
            workflow?.predictedAddressHex ??
            "Available after review"
          }
        />
        <Detail
          label="Factory fee"
          value={review || workflow ? "0 HOG" : "-"}
        />
        <Detail
          label="Funding transfer"
          value={
            review
              ? `${review.fundingAmount} HOG units`
              : workflow
                ? `${workflow.reviewedFundingAmount} HOG units`
                : "-"
          }
        />
        {workflow?.creation.hash ? (
          <Detail
            label="Creation transaction"
            value={shortHash(workflow.creation.hash)}
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
        {workflow?.createdAddressHex ? (
          <Button
            className="w-full justify-between font-mono text-xs"
            variant="outline"
            onClick={() =>
              void navigator.clipboard.writeText(workflow.createdAddressHex!)
            }
          >
            {shortHash(workflow.createdAddressHex)}
            <CopyIcon />
          </Button>
        ) : null}
        {workflow ? (
          <div className="space-y-3" aria-live="polite">
            <ProgressStep label="Fund token address" step={workflow.funding} />
            <ProgressStep
              label="Create and initialize token"
              step={workflow.creation}
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
                      disabled={loading}
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
                >
                  Create another token
                </Button>
              </>
            ) : (
              <Button
                className="min-h-12 w-full"
                onClick={onAdvance}
                disabled={loading}
              >
                {loading
                  ? "Checking transaction..."
                  : nextActionLabel(workflow)}
                <ArrowRightIcon />
              </Button>
            )}
          </div>
        ) : review ? (
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>Factory verified</AlertTitle>
            <AlertDescription>
              The address and zero-fee factory configuration are ready. Continue
              to fund the predicted address.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ProgressStep({
  label,
  step,
}: {
  label: string;
  step: LaunchWorkflow["funding"];
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span>{label}</span>
      <Badge variant={step.status === "committed" ? "secondary" : "outline"}>
        {step.status}
      </Badge>
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

function TokensPage({
  config,
  client,
}: {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
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
  function refresh() {
    setState((value) => ({ ...value, loading: true, error: null }));
    void readCreatedTokens(client, config).then(
      (result) => setState({ loading: false, error: null, ...result }),
      (reason) =>
        setState({
          loading: false,
          tokens: [],
          truncated: false,
          historyLimited: false,
          error:
            reason instanceof Error
              ? reason.message
              : "Token history is unavailable",
        }),
    );
  }
  useEffect(refresh, [client, config]);
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            My tokens
          </h1>
          <p className="mt-2 text-muted-foreground">
            Factory launches created by this wallet.
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
              Launch your first standard token from this wallet.
            </EmptyDescription>
          </EmptyHeader>
          <Button asChild>
            <Link to="/create">Create token</Link>
          </Button>
        </Empty>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {state.tokens.map((token) => (
              <Card key={token.addressHex}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle>{token.name}</CardTitle>
                      <CardDescription>
                        {token.symbol} · {token.decimals} decimals
                      </CardDescription>
                    </div>
                    <Badge variant="secondary">
                      Block {token.block.toString()}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Detail
                    label="Initial supply"
                    value={formatUnits(token.initialSupply, token.decimals)}
                  />
                  <Detail
                    label="Your balance"
                    value={
                      token.balance === null
                        ? "Unavailable"
                        : formatUnits(token.balance, token.decimals)
                    }
                  />
                  <Detail
                    label="Administrator"
                    value={shortHash(token.administratorHex)}
                  />
                  <Detail
                    label="Initial holder"
                    value={shortHash(token.holderHex)}
                  />
                  <Detail
                    label="Transaction"
                    value={shortHash(token.transactionHash)}
                  />
                  <div className="flex items-center gap-2 rounded-lg bg-muted p-3 font-mono text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {token.addressHex}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Copy token address"
                      onClick={() =>
                        void navigator.clipboard.writeText(token.addressHex)
                      }
                    >
                      <CopyIcon />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {state.tokens.some(({ readError }) => readError) ? (
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-3 text-sm last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[65%] break-all text-right font-medium">
        {value}
      </span>
    </div>
  );
}
function short(value: ArrayLike<number>): string {
  const hex = Array.from(value, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `0x${hex.slice(0, 8)}...${hex.slice(-6)}`;
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}
function ErrorPage({ message }: { message: string }) {
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Configuration required</CardTitle>
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
  );
}
