import { useWallet } from "@groundhogchain/react";

export function WalletInstallBanner() {
  const wallet = useWallet();
  if (!wallet || wallet.providers.length > 0) return null;

  return (
    <div
      role="status"
      className="w-full bg-primary px-4 py-2 text-center text-sm text-primary-foreground"
    >
      <a
        href="https://github.com/groundhogchain/hackathon/blob/main/WALLET_SETUP.md"
        className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        Install or enable a Thruput Wallet to use this app
      </a>
    </div>
  );
}
