import {
  AlertCircleIcon,
  ArrowDownUpIcon,
  ChevronDownIcon,
  InfoIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

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
import { isLoopbackUrl, type AppConfig } from "@/config";
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

const SLIPPAGE_PRESETS = [10n, 50n, 100n] as const;

export function SwapPage({
  config,
  readSnapshot,
}: {
  config: AppConfig;
  readSnapshot: SnapshotReader;
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
          <EnvironmentWarning localRpc={isLoopbackUrl(config.rpcUrl)} />
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
      <AlertTitle>{localRpc ? "Local sandbox" : "Read-only preview"}</AlertTitle>
      <AlertDescription>
        Quotes use live {localRpc ? "local-pool" : "configured-pool"} reads.
        Signing remains disabled in this phase; Phase 5 will use browser-visible
        development credentials on loopback only.
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
}: {
  config: AppConfig;
  snapshot: PoolSnapshot;
  refreshError: string | null;
  isRefreshing: boolean;
  isUserRefreshing: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const [direction, setDirection] = useState<SwapDirection>("aToB");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
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

  const output = quote.ok
    ? formatTokenAmount(quote.amountOut, tokens.output.decimals, 8)
    : "—";
  const validationMessage =
    amount.length === 0 || quote.ok ? null : quoteErrorMessages[quote.error];

  function switchDirection() {
    setDirection((current) => (current === "aToB" ? "bToA" : "aToB"));
    setAmount("");
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
                onChange={setSlippage}
                result={slippageResult}
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
                onChange={setAmount}
                onMax={() =>
                  setAmount(
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
              disabled
              className="mt-5 min-h-12 w-full text-base sm:text-sm"
            >
              <LockKeyholeIcon data-icon="inline-start" />
              {actionLabel({
                amount,
                hasLiquidity,
                quoteValid,
                isRefreshing: isUserRefreshing,
                slippageValid: slippageResult.ok,
              })}
            </Button>
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
}: {
  id: string;
  token: TokenSnapshot;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onMax: () => void;
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
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  result: ReturnType<typeof parseSlippagePercent>;
}) {
  const selectedPreset = result.ok
    ? SLIPPAGE_PRESETS.find((preset) => preset === result.basisPoints)?.toString()
    : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="relative font-mono">
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
}): string {
  if (params.isRefreshing) return "Refreshing quote";
  if (!params.hasLiquidity) return "Pool has no liquidity";
  if (params.amount.length === 0) return "Enter an amount";
  if (!params.slippageValid) return "Check slippage";
  if (!params.quoteValid) return "Check amount";
  return "Swap opens in Phase 5";
}
