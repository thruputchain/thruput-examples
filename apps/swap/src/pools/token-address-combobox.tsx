import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getDiscoveryTokens } from "@/token-discovery/client";
import type { DiscoveryConfig } from "@/token-discovery/config";
import type { DiscoveryResponse } from "@/token-discovery/wire";
import { tokenAddress } from "./creation-presets";

export function TokenAddressCombobox({
  label,
  value,
  otherAddress,
  discovery,
  onChange,
}: {
  label: string;
  value: string;
  otherAddress: string;
  discovery: DiscoveryConfig | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([open, query, attempt, discovery]);
  const [result, setResult] = useState<{
    key: string;
    data: DiscoveryResponse | null;
  } | null>(null);
  const enabled = discovery?.enabled === true;
  const selected = tokenAddress(value);
  const other = tokenAddress(otherAddress);
  const manual = tokenAddress(query.trim());
  const error =
    value && selected === null
      ? "Enter a nonzero 32-byte contract address."
      : selected !== null && selected === other
        ? "Choose a different contract from the other token."
        : null;
  const current = result?.key === key ? result : null;

  useEffect(() => {
    setResult(null);
    if (!open || !discovery?.enabled) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(
      () => {
        void getDiscoveryTokens(discovery, query, controller.signal).then(
          (data) => {
            if (active) setResult({ key, data });
          },
          () => {
            if (active) setResult({ key, data: null });
          },
        );
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  function choose(address: string) {
    onChange(address);
    setOpen(false);
  }

  return (
    <Field data-invalid={Boolean(error)} className="min-w-0">
      <FieldLabel htmlFor={id}>Contract address</FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 font-mono"
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-help`}
        onChange={(event) =>
          onChange(tokenAddress(event.target.value) ?? event.target.value)
        }
      />
      <FieldDescription id={`${id}-help`}>
        {error ??
          "Enter any compatible token address, or search indexed suggestions."}
      </FieldDescription>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setQuery("");
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={`Search tokens for ${label}`}
          >
            Search tokens
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label={`Choose ${label}`}
          className="w-96 max-w-[calc(100vw-2rem)] p-0"
        >
          <Command shouldFilter={false} label={`Search tokens for ${label}`}>
            <CommandInput
              aria-label={`Search tokens for ${label}`}
              placeholder="Name, symbol, or address"
              value={query}
              onValueChange={setQuery}
            />
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Search name, symbol, token address, or creator address.
            </p>
            {selected ? (
              <p className="break-all px-3 pb-2 text-xs">
                Selected address: {selected}
              </p>
            ) : null}
            <div
              role="status"
              aria-live="polite"
              className="px-3 py-2 text-sm text-muted-foreground"
            >
              {!enabled
                ? "Token discovery is disabled. You can still use an address."
                : current === null
                  ? "Loading indexed tokens..."
                  : current.data === null
                    ? "Token discovery is unavailable. Try again or use an address."
                    : current.data.tokens.length === 0
                      ? "No indexed matches. You can still use an address."
                      : `${current.data.tokens.length} indexed suggestions.`}
            </div>
            {enabled && current?.data === null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="m-2"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry search
              </Button>
            ) : null}
            <CommandList aria-label={`${label} suggestions`}>
              {manual ? (
                <CommandGroup heading="Manual address">
                  <CommandItem
                    value={`manual:${manual}`}
                    disabled={manual === other}
                    onSelect={() => choose(manual)}
                    className="min-h-11"
                  >
                    <span className="min-w-0 break-all">
                      Use address {manual}
                      {manual === other
                        ? " (already selected for the other token)"
                        : ""}
                    </span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {current?.data ? (
                <CommandGroup heading="Indexed tokens">
                  {current.data.tokens.map((token) => (
                    <CommandItem
                      key={token.tokenAddress}
                      value={token.tokenAddress}
                      data-checked={selected === token.tokenAddress}
                      disabled={other === token.tokenAddress}
                      onSelect={() => choose(token.tokenAddress)}
                      className="min-h-11"
                    >
                      <span
                        className="flex min-w-0 flex-col gap-1"
                        title={token.tokenAddress}
                      >
                        <span className="break-words">
                          {token.name || "Unnamed token"} /{" "}
                          {token.symbol || "No symbol"}
                          {selected === token.tokenAddress ? " (selected)" : ""}
                        </span>
                        <span className="break-all font-mono text-xs">
                          {token.tokenAddress}
                        </span>
                        {other === token.tokenAddress ? (
                          <span>Already selected for the other token</span>
                        ) : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
            {current?.data?.hasMore ? (
              <p className="px-3 py-2 text-xs">
                Showing the newest 20 matches. Refine your search.
              </p>
            ) : null}
            {current?.data?.historyLimited ? (
              <p className="px-3 py-2 text-xs">
                Only retained indexed history is searchable.
              </p>
            ) : null}
            {current?.data && current.data.syncState !== "idle" ? (
              <p className="px-3 py-2 text-xs">
                The registry is {current.data.syncState}; suggestions may not be
                up to date.
              </p>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
    </Field>
  );
}
