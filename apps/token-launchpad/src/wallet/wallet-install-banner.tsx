import { useWallet } from "./use-wallet";

export function WalletInstallBanner() {
  const wallet = useWallet();
  if (!wallet || wallet.providers.length > 0) return null;

  return (
    <div
      role="status"
      className="w-full bg-primary px-4 py-2 text-center text-sm text-primary-foreground"
    >
      Install or enable a Thruput Wallet to use this app
    </div>
  );
}
