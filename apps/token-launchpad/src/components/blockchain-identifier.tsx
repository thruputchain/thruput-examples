import { fixedFromBase58, toBase58 } from "@thruputchain/client";
import { ExternalLinkIcon } from "lucide-react";
import { useExplorerUrl } from "@/components/explorer-context";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type IdentifierKind = "address" | "transaction" | "identifier";

export function BlockchainIdentifier({
  value,
  kind,
}: {
  value: string;
  kind: IdentifierKind;
}) {
  const origin = useExplorerUrl();
  const canonical = isCanonicalBase58(value) ? value : null;
  const href =
    origin && canonical && kind !== "identifier"
      ? `${origin}/${kind === "transaction" ? "tx" : "address"}/${canonical}`
      : null;
  const shortened =
    value.length > 14 ? `${value.slice(0, 8)}\u2026${value.slice(-4)}` : value;
  const className =
    "inline-flex items-center gap-1 rounded-sm font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
            aria-label={`${value} (opens in new tab)`}
          >
            {shortened}
            <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
          </a>
        ) : (
          <span tabIndex={0} className={className} aria-label={value}>
            {shortened}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        <span className="min-w-0 break-all font-mono">{value}</span>
      </TooltipContent>
    </Tooltip>
  );
}

// Addresses and transaction hashes are 32 bytes of case-sensitive base58.
function isCanonicalBase58(value: string): boolean {
  try {
    return toBase58(fixedFromBase58(value, 32)) === value;
  } catch {
    return false;
  }
}
