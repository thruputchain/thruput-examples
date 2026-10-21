import { useWallet } from "@thruputchain/react";
import { LogOutIcon } from "lucide-react";
import { WalletProviderError } from "@thruputchain/client/provider";

export function WalletControls() {
  const wallet = useWallet();
  const error =
    wallet.error instanceof WalletProviderError && wallet.error.code === 4001
      ? null
      : wallet.error;
  const address = wallet.address;
  const busy =
    wallet.status === "connecting" || wallet.status === "disconnecting";
  return (
    <section aria-label="Wallet" className="wallet">
      <div className="actions">
        {wallet.providers.length > 1 && wallet.status !== "connected" ? (
          <select
            aria-label="Wallet provider"
            name="provider"
            value={wallet.provider?.info.id ?? ""}
            onChange={(e) => wallet.selectProvider(e.target.value)}
          >
            {wallet.providers.map((p) => (
              <option key={p.info.id} value={p.info.id}>
                {p.info.name}
              </option>
            ))}
          </select>
        ) : null}
        {wallet.status === "connected" || wallet.status === "wrongNetwork" ? (
          <button
            className="primary gap-2"
            type="button"
            aria-label="Disconnect"
            title={`Disconnect ${address}`}
            disabled={busy}
            onClick={() => void wallet.disconnect()}
          >
            {address?.slice(0, 6)}...{address?.slice(-4)}
            <LogOutIcon aria-hidden="true" size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!wallet.provider || busy}
            onClick={() => void wallet.connect()}
          >
            {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>
      {wallet.status === "wrongNetwork" ? (
        <p role="alert">Select this localnode in your wallet.</p>
      ) : null}
      {error ? <p role="alert">{error.message}</p> : null}
      {wallet.session && wallet.session.accounts.length > 1 ? (
        <select
          name="account"
          aria-label="Wallet account"
          value={address ?? ""}
          onChange={(e) => wallet.selectAccount(e.target.value)}
        >
          {wallet.session.accounts.map((a) => (
            <option key={a.address} value={a.address}>
              {a.address}
            </option>
          ))}
        </select>
      ) : null}
    </section>
  );
}
