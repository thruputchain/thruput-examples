import { AlertCircleIcon, Settings2Icon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatBasisPoints, parseSlippagePercent } from "@/swap/model";

const SLIPPAGE_PRESETS = [10n, 50n, 100n] as const;

export function SlippageSettings({
  id,
  value,
  onChange,
  result,
  disabled,
  description = "Set the minimum acceptable amounts for this preview.",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  result: ReturnType<typeof parseSlippagePercent>;
  disabled: boolean;
  description?: string;
}) {
  const selectedPreset = result.ok
    ? SLIPPAGE_PRESETS.find(
      (preset) => preset === result.basisPoints,
    )?.toString()
    : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="relative font-mono"
        >
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
            {description}
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
              disabled={disabled}
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
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              className="h-12 pr-9 font-mono tabular-nums sm:h-9"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">
              %
            </span>
          </div>
          {!result.ok
            ? (
              <FieldError id={`${id}-error`}>
                Enter more than 0% and no more than 50%, using at most two
                decimals.
              </FieldError>
            )
            : null}
        </Field>
        {result.ok && result.basisPoints > 500n
          ? (
            <Alert variant="destructive">
              <AlertCircleIcon aria-hidden="true" />
              <AlertTitle>High slippage</AlertTitle>
              <AlertDescription>
                More than 5% can materially change the executed amounts.
              </AlertDescription>
            </Alert>
          )
          : null}
      </PopoverContent>
    </Popover>
  );
}
