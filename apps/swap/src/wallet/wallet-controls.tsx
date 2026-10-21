import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@thruputchain/react";
import { WalletProviderError } from "@thruputchain/client/provider";

export function WalletInstallBanner() {
  const { providers } = useWallet();
  if (providers.length) return null;
  return (
    <div
      role="status"
      className="w-full bg-signal px-4 py-2 text-center text-sm text-primary-foreground"
    >
      <a
        href="https://github.com/thruputchain/freighter"
        className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        Install or enable Thruput Freighter to use this app
      </a>
    </div>
  );
}

export function WalletControls() {
  const wallet = useWallet();
  const busy =
    wallet.status === "connecting" || wallet.status === "disconnecting";
  const address = wallet.status === "connected" ? wallet.address : null;
  const error =
    wallet.error instanceof WalletProviderError && wallet.error.code === 4001
      ? null
      : wallet.error;
  const selectClass =
    "max-w-48 rounded-md border border-input bg-background px-2 py-1 text-sm";
  return (
    <section
      aria-label="Wallet connection"
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      {!address && wallet.providers.length > 1 ? (
        <label className="flex items-center gap-2">
          Wallet
          <select
            className={selectClass}
            aria-label="Wallet provider"
            disabled={busy}
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
      {address ? (
        <Button
          aria-label="Disconnect"
          title={`Disconnect ${address}`}
          disabled={busy}
          onClick={() => void wallet.disconnect()}
        >
          {address.slice(0, 6)}...{address.slice(-4)}
          <LogOutIcon aria-hidden="true" data-icon="inline-end" />
        </Button>
      ) : (
        <>
          <Button
            disabled={!wallet.provider || busy}
            onClick={() => void wallet.connect()}
          >
            {busy ? "Connecting..." : "Connect wallet"}
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
