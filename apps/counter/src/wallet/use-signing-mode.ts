import { useWallet } from "@thruputchain/react";

export type SigningMode = "development" | "wallet";

export function useSigningMode(hasWalletUpdate = false) {
  const wallet = useWallet();
  const authorized =
    wallet.status === "connected" || wallet.status === "wrongNetwork";
  const mode: SigningMode =
    authorized || hasWalletUpdate ? "wallet" : "development";
  function disconnect() {
    void wallet.disconnect();
  }
  return {
    mode,
    disconnect,
    busy: wallet.status === "connecting" || wallet.status === "disconnecting",
  };
}
