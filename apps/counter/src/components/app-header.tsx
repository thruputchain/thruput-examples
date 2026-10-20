import { TopupSigner } from "./topup-signer";
import type { ReactNode } from "react";

export function AppHeader({
  walletControls,
  canTopup,
  signerBalance,
}: {
  walletControls?: ReactNode;
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
          <div className="flex items-center gap-2 whitespace-nowrap text-[17px] font-medium min-[384px]:gap-3 min-[384px]:text-xl">
            <picture className="shrink-0">
              <source
                srcSet="/brand/stellar-dark.svg"
                media="(prefers-color-scheme: dark)"
              />
              <img
                src="/brand/stellar.svg"
                width="100"
                height="25"
                alt="Stellar"
                className="w-20 min-[384px]:w-25"
              />
            </picture>
            <span className="border-l pl-2 min-[384px]:pl-3">
              Thruput Counter
            </span>
          </div>
        </a>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-3">
          {canTopup ? (
            <div className="flex min-w-0 max-w-full justify-end">
              <TopupSigner disabled={false} balance={signerBalance} />
            </div>
          ) : null}
          {walletControls}
        </div>
      </div>
    </header>
  );
}
