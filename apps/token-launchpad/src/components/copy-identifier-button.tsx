import { CopyIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";

export function CopyIdentifierButton({
  value,
  label,
  variant = "outline",
}: {
  value: string;
  label: string;
  variant?: "outline" | "ghost";
}) {
  const statusId = useId();
  const [result, setResult] = useState<{
    value: string;
    message: string;
  } | null>(null);
  if (result && result.value !== value) setResult(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult({ value, message: "Copied" });
    } catch {
      setResult({ value, message: "Copy failed" });
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="icon-sm"
        variant={variant}
        aria-label={label}
        aria-describedby={statusId}
        onClick={() => void copy()}
      >
        <CopyIcon />
      </Button>
      <span
        id={statusId}
        role="status"
        className="text-xs text-muted-foreground"
      >
        {result?.value === value ? result.message : null}
      </span>
    </div>
  );
}
