import { fromHex0x, toBase58 } from "@thruputchain/client";
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
  // The app keeps 32-byte identifiers as 0x hex; people see the base58 form.
  const identifier = /^0x[0-9a-fA-F]{64}$/.test(value);
  const shown = identifier ? toBase58(fromHex0x(value)) : value;
  const href =
    !nonInteractive && explorerUrl && kind !== "identifier" && identifier
      ? `${explorerUrl}/${kind === "transaction" ? "tx" : "address"}/${shown}`
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
