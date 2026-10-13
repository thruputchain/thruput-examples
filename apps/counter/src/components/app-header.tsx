import { ZapIcon } from "lucide-react";
import { TopupSigner } from "./topup-signer";

export function AppHeader({
  ready,
  canTopup,
  signerBalance,
}: {
  ready: boolean;
  canTopup: boolean;
  signerBalance: bigint | null;
}) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto grid min-h-20 max-w-5xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-6 lg:min-h-22">
        <a
          href="/"
          aria-label="Thruput Counter homepage"
          className="flex min-h-12 items-center gap-2.5 justify-self-start"
        >
          <ZapIcon
            className="size-6 shrink-0 fill-primary stroke-primary"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <div className="text-xl font-medium tracking-tight">THRUPUT</div>
            <div className="font-mono text-xs text-muted-foreground sm:border-l sm:pl-3">
              Counter
            </div>
          </div>
        </a>
        <div className="flex min-h-12 items-center gap-2 justify-self-end font-mono text-xs text-muted-foreground sm:min-h-9">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${ready ? "bg-local" : "bg-muted-foreground"}`}
          />
          <span>{ready ? "Connected" : "Not ready"}</span>
        </div>
        {canTopup ? (
          <div className="col-span-2 min-w-0 max-w-full justify-self-end sm:col-span-1">
            <TopupSigner disabled={false} balance={signerBalance} />
          </div>
        ) : null}
      </div>
    </header>
  );
}
