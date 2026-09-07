import { cn } from "@/lib/utils";
import { useExplorerUrl } from "./explorer-context";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { abbreviateIdentifier } from "@/lib/address";

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
  const href =
    !nonInteractive &&
    explorerUrl &&
    kind !== "identifier" &&
    /^0x[0-9a-fA-F]{64}$/.test(value)
      ? `${explorerUrl}/${kind === "transaction" ? "tx" : "address"}/${value.toLowerCase()}`
      : undefined;
  const props = {
    "aria-label": `${label}: ${value}${href ? " (opens explorer in a new tab)" : ""}`,
    className: cn(
      "inline-flex max-w-full rounded-sm border-0 bg-transparent p-0 font-mono text-inherit underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
      className,
    ),
    children: abbreviateIdentifier(value),
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
        {value}
      </TooltipContent>
    </Tooltip>
  );
}
