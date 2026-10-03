import { useWallet } from "@groundhogchain/react";
import type { SigningMode } from "./use-signing-mode";

export function WalletControls({ mode, disconnect }: { mode: SigningMode; disconnect(): void }) {
  const wallet = useWallet();
  const busy = wallet.status === "connecting" || wallet.status === "disconnecting";
  return (
    <section aria-label="Wallet connection" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="counter-wallet">Wallet</label>
        <select id="counter-wallet" name="wallet" className="min-w-0 max-w-full rounded-md border bg-background p-2" value={wallet.provider?.info.id ?? ""} disabled={busy || wallet.providers.length === 0} onChange={event => wallet.selectProvider(event.target.value)}>
          <option value="" disabled>No wallet detected</option>
          {wallet.providers.map(provider => <option key={provider.info.id} value={provider.info.id}>{provider.info.name}</option>)}
        </select>
        <button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-accent" disabled={busy || !wallet.provider || wallet.status === "connected"} onClick={() => void wallet.connect()}>{wallet.status === "connecting" ? "Connecting…" : wallet.status === "connected" ? "Connected wallet" : "Connect wallet"}</button>
        {mode === "wallet" ? <button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-accent" disabled={busy} onClick={disconnect}>Disconnect wallet</button> : null}
      </div>
      {wallet.session && wallet.session.accounts.length > 1 ? (
        <label className="flex min-w-0 flex-col gap-2">Account
          <select name="account" className="max-w-full rounded-md border bg-background p-2" value={wallet.address ?? ""} disabled={busy} onChange={event => wallet.selectAccount(event.target.value)}>
            {wallet.session.accounts.map(account => <option key={account.address} value={account.address}>{account.address}</option>)}
          </select>
        </label>
      ) : null}
      {wallet.status === "wrongNetwork" ? <p role="alert">Select the application's network in your wallet.</p> : null}
      {wallet.error ? <p role="alert">{wallet.error.message}</p> : null}
    </section>
  );
}
