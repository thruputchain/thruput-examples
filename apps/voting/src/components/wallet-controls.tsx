import { useClient, useWallet } from "@thruputchain/react";
import { useQuery } from "@tanstack/react-query";
import { addressFromBase58, formatUnits } from "@thruputchain/client";

export function WalletControls() {
  const wallet = useWallet();
  const client = useClient();
  const address = wallet.address;
  const balance = useQuery({
    queryKey: ["voting", "balance", address],
    enabled: Boolean(address),
    queryFn: () => client.getBalance({ address: addressFromBase58(address!) }),
    refetchInterval: 5_000,
  });
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
          <button type="button" onClick={() => void wallet.disconnect()}>
            Disconnect {address?.slice(0, 6)}…
          </button>
        ) : (
          <button
            type="button"
            disabled={!wallet.provider || wallet.status === "connecting"}
            onClick={() => void wallet.connect()}
          >
            {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>
      {balance.data ? (
        <p className="mono muted">
          {formatUnits(balance.data.rawBalance, 7)} HOG
        </p>
      ) : null}
      {balance.error ? <p role="alert">Balance unavailable.</p> : null}
      {wallet.status === "wrongNetwork" ? (
        <p role="alert">Select this localnode in your wallet.</p>
      ) : null}
      {wallet.error ? <p role="alert">{wallet.error.message}</p> : null}
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
