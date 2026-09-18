import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "../config";

function formatHog(raw: bigint, fractionDigits = 7): string {
  const fraction = (raw % 10_000_000n)
    .toString()
    .padStart(7, "0")
    .slice(0, fractionDigits)
    .replace(/0+$/, "");
  return `${raw / 10_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function TopupSigner({
  disabled,
  balance,
}: {
  disabled: boolean;
  balance: bigint | null;
}) {
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const balanceLabel =
    balance === null
      ? "—"
      : balance > 0n && balance < 10_000n
        ? "<0.001"
        : formatHog(balance, 3);

  async function topup() {
    if (disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    const toastId = toast.loading("Requesting signer airdrop…");
    try {
      const response = await fetch("/api/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(90_000),
        ]),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          errorMessage(body, "Could not confirm the signer top-up."),
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        !("rawAmount" in body) ||
        typeof body.rawAmount !== "string" ||
        !/^\d+$/.test(body.rawAmount)
      ) {
        throw new Error("The server returned an invalid airdrop result.");
      }
      const amount = BigInt(body.rawAmount);
      if (!controller.signal.aborted)
        toast.success(`Signer received ${formatHog(amount)} HOG.`, {
          id: toastId,
        });
    } catch (error) {
      if (!controller.signal.aborted)
        toast.error(errorMessage(error), { id: toastId });
    } finally {
      if (controller.signal.aborted) toast.dismiss(toastId);
      else setPending(false);
      request.current = null;
    }
  }

  return (
    <button
      type="button"
      onClick={() => void topup()}
      disabled={disabled || pending}
      aria-busy={pending}
      title={
        balance === null
          ? "Signer balance unavailable"
          : `Signer balance: ${formatHog(balance)} HOG`
      }
      className="flex min-h-12 max-w-full items-center justify-center rounded-md border bg-secondary px-3 py-2 font-mono text-sm tabular-nums hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-9"
    >
      <span className="truncate">Top up Signer (curr {balanceLabel} HOG)</span>
    </button>
  );
}
