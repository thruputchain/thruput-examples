import { useEffect, useId, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
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
import { tokenAddress } from "./creation-presets";
import { addressFromHex, toBase58 } from "@thruputchain/client";

// Form state holds 0x hex; people only see the base58 form.
function shown(value: string): string {
  return /^0x[0-9a-f]{64}$/.test(value)
    ? toBase58(addressFromHex(value))
    : value;
}

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
  const [highlighted, setHighlighted] = useState("");
  const [debounced, setDebounced] = useState("");
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
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), query.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query]);
  const result = useQuery({
    queryKey: ["token-discovery", discovery?.scope, open ? debounced : null],
    queryFn:
      open && discovery?.enabled
        ? ({ signal }) => getDiscoveryTokens(discovery, debounced, signal)
        : skipToken,
    enabled: query === debounced,
    retry: false,
  });
  const current =
    query !== debounced || result.isPending
      ? null
      : { data: result.isError ? null : (result.data ?? null) };

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
        value={shown(value)}
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
      {selected ? (
        <BlockchainIdentifier
          kind="address"
          value={selected}
          label="Selected token address"
        />
      ) : null}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setQuery("");
          setHighlighted("");
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
          <Command
            shouldFilter={false}
            value={highlighted}
            onValueChange={setHighlighted}
            label={`Search tokens for ${label}`}
          >
            <CommandInput
              aria-label={`Search tokens for ${label}`}
              placeholder="Name, symbol, or address"
              value={query}
              onValueChange={setQuery}
            />
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Search name, symbol, token address, or creator address.
            </p>
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
                onClick={() => void result.refetch()}
              >
                Retry search
              </Button>
            ) : null}
            <CommandList aria-label={`${label} suggestions`}>
              {manual ? (
                <CommandGroup heading="Manual address">
                  <CommandItem
                    aria-label={`Use address ${shown(manual)}${manual === other ? " (already selected for the other token)" : ""}`}
                    value={`manual:${manual}`}
                    disabled={manual === other}
                    onSelect={() => choose(manual)}
                    className="min-h-11"
                  >
                    <span className="min-w-0 break-all">
                      Use address{" "}
                      <BlockchainIdentifier
                        nonInteractive
                        value={manual}
                        kind="address"
                        label="Manual address"
                      />
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
                      aria-label={`${token.name || "Unnamed token"} / ${token.symbol || "No symbol"} ${shown(token.tokenAddress)}${selected === token.tokenAddress ? " (selected)" : ""}${other === token.tokenAddress ? " (already selected for the other token)" : ""}`}
                      key={token.tokenAddress}
                      value={token.tokenAddress}
                      data-checked={selected === token.tokenAddress}
                      disabled={other === token.tokenAddress}
                      onSelect={() => choose(token.tokenAddress)}
                      className="min-h-11"
                    >
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="break-words">
                          {token.name || "Unnamed token"} /{" "}
                          {token.symbol || "No symbol"}
                          {selected === token.tokenAddress ? " (selected)" : ""}
                        </span>
                        <span className="break-all font-mono text-xs">
                          <BlockchainIdentifier
                            nonInteractive
                            kind="address"
                            value={token.tokenAddress}
                            label="Suggested token address"
                          />
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
          {selected ? (
            <p className="px-3 pb-2 text-xs">
              Selected address:{" "}
              <BlockchainIdentifier
                kind="address"
                value={selected}
                label="Selected address"
              />
            </p>
          ) : null}
          {tokenAddress(highlighted.replace(/^manual:/, "")) ? (
            <p className="px-3 pb-2 text-xs">
              Highlighted address:{" "}
              <BlockchainIdentifier
                kind="address"
                value={highlighted.replace(/^manual:/, "")}
                label="Highlighted token address"
              />
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
