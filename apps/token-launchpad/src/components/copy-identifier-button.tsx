import { CheckIcon, CopyIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

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
  const latestAttempt = useRef(0);
  const [result, setResult] = useState<{
    value: string;
    message: string;
  } | null>(null);
  if (result && result.value !== value) setResult(null);

  async function copy() {
    const attempt = ++latestAttempt.current;
    try {
      await navigator.clipboard.writeText(value);
      if (attempt === latestAttempt.current) {
        setResult({ value, message: "Copied" });
      }
    } catch {
      if (attempt === latestAttempt.current) {
        setResult({ value, message: "Copy failed" });
      }
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
        {result?.value === value && result.message === "Copied" ? (
          <CheckIcon />
        ) : (
          <CopyIcon />
        )}
      </Button>
      <span id={statusId} role="status" className="sr-only">
        {result?.value === value ? result.message : null}
      </span>
    </div>
  );
}
