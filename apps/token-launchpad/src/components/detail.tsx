import type { ReactNode } from "react";
import {
  BlockchainIdentifier,
  type IdentifierKind,
} from "./blockchain-identifier";
import { CopyIdentifierButton } from "./copy-identifier-button";

export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-3 text-sm last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[65%] break-all text-right font-mono font-medium tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function IdentifierDetail({
  label,
  value,
  kind = "identifier",
}: {
  label: string;
  value: string;
  kind?: IdentifierKind;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex min-h-12 items-center justify-between gap-2 rounded-md border px-3">
        <BlockchainIdentifier value={value} kind={kind} />
        <CopyIdentifierButton value={value} label={`Copy ${label}: ${value}`} />
      </div>
    </div>
  );
}
