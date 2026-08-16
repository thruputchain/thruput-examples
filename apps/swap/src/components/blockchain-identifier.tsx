import { cn } from "@/lib/utils";
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
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${value}`}
          className={cn(
            "inline-flex max-w-full rounded-sm border-0 bg-transparent p-0 font-mono text-inherit underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          {abbreviateIdentifier(value)}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all font-mono">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}
