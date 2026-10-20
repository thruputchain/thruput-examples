import { cn } from "@/lib/utils";
import { useExplorerUrl } from "./explorer-context";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { abbreviateIdentifier, isBase58Identifier } from "@/lib/address";

export function BlockchainIdentifier({
  value,
  label,
  className,
  kind = "identifier",
  nonInteractive = false,
}: {
  value: string;
  label: string;
  className?: string;
  kind?: "address" | "transaction" | "identifier";
  nonInteractive?: boolean;
}) {
  const explorerUrl = useExplorerUrl();
  // Addresses and transaction hashes are canonical base58; only those link out.
  const shown = value;
  const href =
    !nonInteractive &&
    explorerUrl &&
    kind !== "identifier" &&
    isBase58Identifier(value)
      ? `${explorerUrl}/${kind === "transaction" ? "tx" : "address"}/${value}`
      : undefined;
  const props = {
    "aria-label": `${label}: ${shown}${href ? " (opens explorer in a new tab)" : ""}`,
    className: cn(
      "inline-flex max-w-full rounded-sm border-0 bg-transparent p-0 font-mono text-inherit underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
      className,
    ),
    children: abbreviateIdentifier(shown),
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {nonInteractive ? (
          <span {...props} />
        ) : href ? (
          <a {...props} href={href} target="_blank" rel="noopener noreferrer" />
        ) : (
          <button {...props} type="button" />
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(24rem,calc(100vw-2rem))] break-all font-mono">
        {shown}
      </TooltipContent>
    </Tooltip>
  );
}
