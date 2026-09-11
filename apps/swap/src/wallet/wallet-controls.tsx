import { Button } from "@/components/ui/button";
import { useWallet } from "./use-wallet";

export function WalletControls() {
  const wallet = useWallet();
  if (!wallet) return null;
  const selectClass =
    "max-w-48 rounded-md border border-input bg-background px-2 py-1 text-sm";
  return (
    <section
      aria-label="Wallet connection"
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      {wallet.providers.length > 1 ? (
        <label className="flex items-center gap-2">
          Wallet
          <select
            className={selectClass}
            aria-label="Wallet provider"
            disabled={wallet.busy}
            value={wallet.provider?.info.id ?? ""}
            onChange={(event) => wallet.selectProvider(event.target.value)}
          >
            {wallet.providers.map((provider) => (
              <option key={provider.info.id} value={provider.info.id}>
                {provider.info.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {wallet.address ? (
        <>
          <label className="flex items-center gap-2">
            Account
            <select
              className={selectClass}
              aria-label="Wallet account"
              disabled={wallet.busy}
              value={wallet.address}
              onChange={(event) => wallet.selectAccount(event.target.value)}
            >
              {wallet.session?.accounts.map((account) => (
                <option key={account.address} value={account.address}>
                  {account.address.slice(0, 10)}...{account.address.slice(-8)}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            disabled={wallet.busy}
            onClick={() => void wallet.disconnect()}
          >
            Disconnect
          </Button>
        </>
      ) : (
        <>
          {!wallet.providers.length ? (
            <span className="text-sm text-muted-foreground">
              No wallet found
            </span>
          ) : null}
          <Button
            disabled={!wallet.provider || wallet.busy}
            onClick={() => void wallet.connect()}
          >
            {wallet.busy
              ? "Connecting..."
              : wallet.provider
                ? `Connect ${wallet.provider.info.name}`
                : "Connect wallet"}
          </Button>
        </>
      )}
      {wallet.error ? (
        <p role="alert" className="text-sm text-destructive">
          {wallet.error}
        </p>
      ) : null}
    </section>
  );
}
