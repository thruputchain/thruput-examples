import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

/** One token from the Launchpad app's `GET /api/tokens`. */
interface LaunchpadToken {
  address: string;
  name: string | null;
  symbol: string | null;
}

/**
 * Search the tokens that the Launchpad app indexed. On the hosted site both
 * apps share one origin; locally, the Swap dev server forwards
 * `/launchpad/api` to the Launchpad dev server.
 */
async function searchLaunchpadTokens(
  query: string,
  signal: AbortSignal,
): Promise<LaunchpadToken[]> {
  const params = new URLSearchParams({ limit: "20", offset: "0" });
  if (query) params.set("q", query);
  const response = await fetch(`/launchpad/api/tokens?${params}`, { signal });
  if (!response.ok) throw new Error("Token search is unavailable.");
  const body = (await response.json()) as { tokens?: LaunchpadToken[] };
  if (!Array.isArray(body.tokens)) throw new Error("Token search is unavailable.");
  return body.tokens;
}

/** A token address input, with an optional search of Launchpad tokens. */
export function TokenField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (address: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useQuery({
    queryKey: ["launchpad-tokens", query],
    queryFn: ({ signal }) => searchLaunchpadTokens(query.trim(), signal),
    enabled: open,
    retry: false,
  });
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          aria-label={`${label} address`}
          className="font-mono"
          value={value}
          placeholder="Token contract address"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.trim())}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label={`Search tokens for ${label}`}
            >
              Search
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-96 max-w-[calc(100vw-2rem)] p-0"
          >
            <Command shouldFilter={false} label={`Search tokens for ${label}`}>
              <CommandInput
                aria-label={`Search tokens for ${label}`}
                placeholder="Name, symbol, or address"
                value={query}
                onValueChange={setQuery}
              />
              <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                {search.isError
                  ? "Token search is unavailable. Paste an address instead."
                  : search.data
                    ? `${search.data.length} Launchpad tokens.`
                    : "Searching…"}
              </p>
              <CommandList aria-label={`${label} suggestions`}>
                <CommandGroup>
                  {(search.data ?? []).map((token) => (
                    <CommandItem
                      key={token.address}
                      value={token.address}
                      className="min-h-11"
                      onSelect={() => {
                        onChange(token.address);
                        setOpen(false);
                      }}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span>
                          {token.symbol ?? "TOKEN"} · {token.name ?? "Unnamed token"}
                        </span>
                        <span className="break-all font-mono text-xs text-muted-foreground">
                          {token.address}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <FieldDescription>
        Paste a token address, or search tokens created in the Launchpad app.
      </FieldDescription>
    </Field>
  );
}
