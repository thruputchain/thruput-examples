import { useWallet } from "@thruputchain/react";
import type { SigningMode } from "./use-signing-mode";

export function WalletControls({
  mode,
  disconnect,
}: {
  mode: SigningMode;
  disconnect(): void;
}) {
  const wallet = useWallet();
  const busy =
    wallet.status === "connecting" || wallet.status === "disconnecting";
  return (
    <section
      aria-label="Wallet connection"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        {wallet.providers.length > 1 && wallet.status !== "connected" ? (
          <>
            <label className="sr-only" htmlFor="counter-wallet">
              Wallet
            </label>
            <select
              id="counter-wallet"
              name="wallet"
              className="min-w-0 max-w-full rounded-md border bg-background p-2"
              value={wallet.provider?.info.id ?? ""}
              disabled={busy || wallet.providers.length === 0}
              onChange={(event) => wallet.selectProvider(event.target.value)}
            >
              <option value="" disabled>
                No wallet detected
              </option>
              {wallet.providers.map((provider) => (
                <option key={provider.info.id} value={provider.info.id}>
                  {provider.info.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {wallet.status !== "connected" ? (
          <button
            type="button"
            className="rounded-md bg-signal px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            disabled={busy || !wallet.provider}
            onClick={() => void wallet.connect()}
          >
            {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        ) : null}
        {mode === "wallet" &&
        (wallet.status === "connected" || wallet.status === "wrongNetwork") ? (
          <button
            type="button"
            className="rounded-md bg-signal px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            aria-label="Disconnect wallet"
            disabled={busy}
            onClick={disconnect}
          >
            {wallet.address
              ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
              : "Disconnect wallet"}
          </button>
        ) : null}
      </div>
      {wallet.session && wallet.session.accounts.length > 1 ? (
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="counter-account">Account</label>
          <select
            id="counter-account"
            name="account"
            className="max-w-full rounded-md border bg-background p-2"
            value={wallet.address ?? ""}
            disabled={busy}
            onChange={(event) => wallet.selectAccount(event.target.value)}
          >
            {wallet.session.accounts.map((account) => (
              <option key={account.address} value={account.address}>
                {account.address}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {wallet.status === "wrongNetwork" ? (
        <p role="alert">Select the application's network in your wallet.</p>
      ) : null}
      {wallet.error ? <p role="alert">{wallet.error.message}</p> : null}
    </section>
  );
}
