import { toBase58 } from "@thruputchain/client";
import { ChevronDownIcon } from "lucide-react";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AppConfig } from "@/config";
import {
  deriveSwapQuote,
  formatTokenAmount,
  formatExchangeRate,
  formatBasisPoints,
  formatSignedTokenAmount,
} from "./model";
import type { TokenSnapshot } from "./snapshot";

export function TokenInputPanel({
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
    <Field
      data-invalid={error !== null}
      className="gap-3 rounded-lg border bg-muted p-4 has-focus-within:border-ring has-focus-within:ring-1 has-focus-within:ring-ring"
    >
      <div className="flex items-center justify-between gap-3">
        <FieldLabel
          htmlFor={id}
          className="font-mono text-xs text-muted-foreground"
        >
          YOU PAY
        </FieldLabel>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          Balance {formatTokenAmount(token.balance, token.decimals, 6)}
        </p>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-3 min-[400px]:flex-row min-[400px]:items-center">
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

export function TokenOutputPanel({
  token,
  value,
}: {
  token: TokenSnapshot;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs text-muted-foreground">YOU RECEIVE</p>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          Balance {formatTokenAmount(token.balance, token.decimals, 6)}
        </p>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-3 min-[400px]:flex-row min-[400px]:items-center">
        <output
          aria-label="Estimated output"
          aria-live="polite"
          className="w-full min-w-0 flex-1 font-mono text-3xl font-medium tracking-tight break-all tabular-nums sm:text-4xl"
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
    <Badge
      variant="outline"
      className="h-9 shrink-0 bg-card px-2.5 font-mono text-sm"
    >
      {token.symbol}
    </Badge>
  );
}

interface QuoteProps {
  quote: Extract<ReturnType<typeof deriveSwapQuote>, { ok: true }> | null;
  input: TokenSnapshot;
  output: TokenSnapshot;
  slippageValid: boolean;
}

function rate({ quote, input, output }: QuoteProps) {
  return quote === null
    ? "—"
    : `1 ${input.symbol} = ${formatExchangeRate({ amountIn: quote.amountIn, inputDecimals: input.decimals, amountOut: quote.amountOut, outputDecimals: output.decimals })} ${output.symbol}`;
}
function minimum({ quote, output, slippageValid }: QuoteProps) {
  return quote === null || !slippageValid
    ? "—"
    : `${formatTokenAmount(quote.amountOutMin, output.decimals, 8)} ${output.symbol}`;
}
function impact(quote: QuoteProps["quote"]) {
  return quote === null || quote.priceImpactBps === null
    ? "—"
    : `${formatBasisPoints(quote.priceImpactBps)}%`;
}

export function QuoteSummary(props: QuoteProps) {
  const { quote, output } = props;
  const rows = [
    [
      "Estimated output",
      quote === null
        ? "—"
        : `${formatTokenAmount(quote.amountOut, output.decimals, 8)} ${output.symbol}`,
    ],
    ["Minimum output", minimum(props)],
    ["Rate", rate(props)],
    ["Price impact", impact(quote)],
    ["Swap fee", "0.3%"],
  ];
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-base sm:text-sm">
      {rows.map(([label, value]) => (
        <Row key={label} label={label!} value={value} />
      ))}
    </dl>
  );
}

export function TransactionDetails({
  config,
  ...props
}: QuoteProps & { config: AppConfig }) {
  const { quote, input } = props;
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="group min-h-12 w-full justify-between sm:min-h-9"
        >
          Transaction details
          <ChevronDownIcon
            aria-hidden="true"
            className="group-data-open:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 px-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 font-mono text-xs">
          <Row label="Rate" value={rate(props)} />
          <Row label="Swap fee" value="0.3%" />
          <Row label="Price impact" value={impact(quote)} />
          <Row
            label="Allowance change"
            value={
              quote === null
                ? "—"
                : `${formatSignedTokenAmount(quote.allowanceDifference, input.decimals, 8)} ${input.symbol}`
            }
          />
          <Row label="Protected output" value={minimum(props)} />
          <Row
            label="Handler"
            value={
              <BlockchainIdentifier
                kind="address"
                value={toBase58(config.handlerAddress)}
                label="Handler address"
              />
            }
          />
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="text-right text-muted-foreground tabular-nums">{value}</dd>
    </>
  );
}
