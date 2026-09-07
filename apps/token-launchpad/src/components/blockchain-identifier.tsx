import { ExternalLinkIcon } from "lucide-react";
import { createContext, use, type ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { loadExplorerUrl } from "@/explorer-config";

const ExplorerContext = createContext<string | null>(null);
export type IdentifierKind = "address" | "transaction" | "identifier";

export function ExplorerProvider({
  explorerUrl,
  children,
}: {
  explorerUrl?: string | null | undefined;
  children: ReactNode;
}) {
  let origin: string | null = null;
  try {
    origin = loadExplorerUrl(explorerUrl ?? undefined);
  } catch {
    // Supplied configs must not turn malformed origins into navigation targets.
  }
  return (
    <ExplorerContext value={origin}>
      <TooltipProvider>{children}</TooltipProvider>
    </ExplorerContext>
  );
}

export function BlockchainIdentifier({
  value,
  kind,
}: {
  value: string;
  kind: IdentifierKind;
}) {
  const origin = use(ExplorerContext);
  const canonical =
    (value.length === 64 || value.length === 66) &&
    /^(?:0x)?[0-9a-fA-F]{64}$/.test(value)
      ? `0x${value.replace(/^0x/, "").toLowerCase()}`
      : null;
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
