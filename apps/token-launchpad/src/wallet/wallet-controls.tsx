import { LogOutIcon } from "lucide-react";
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
      {!wallet.address && wallet.providers.length > 1 ? (
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
        <Button
          aria-label="Disconnect"
          title={`Disconnect ${wallet.address}`}
          disabled={wallet.busy}
          onClick={() => void wallet.disconnect()}
        >
          {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
          <LogOutIcon aria-hidden="true" data-icon="inline-end" />
        </Button>
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
