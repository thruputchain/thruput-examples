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
      <div className="mx-auto flex min-h-20 max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:min-h-22">
        <a
          href="/"
          aria-label="Thruput Counter homepage"
          className="flex min-h-12 items-center gap-2.5 justify-self-start"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3 text-sm font-medium">
              <picture className="shrink-0">
                <source srcSet="/brand/stellar-dark.svg" media="(prefers-color-scheme: dark)" />
                <img src="/brand/stellar.svg" width="100" height="25" alt="Stellar" />
              </picture>
              <span className="border-l pl-3">Thruput</span>
            </div>
            <div className="font-mono text-xs text-muted-foreground">
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
          <div className="flex min-w-0 max-w-full justify-end">
            <TopupSigner disabled={false} balance={signerBalance} />
          </div>
        ) : null}
      </div>
    </header>
  );
}
