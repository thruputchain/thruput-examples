import { useEffect, useState } from "react";
import { useWallet } from "@groundhogchain/react";

export type SigningMode = "development" | "wallet";

export function useSigningMode() {
  const wallet = useWallet();
  const [selected, setSelected] = useState<SigningMode>("development");
  const authorized = wallet.status === "connected" || wallet.status === "wrongNetwork";
  useEffect(() => { if (authorized) setSelected("wallet"); }, [authorized]);
  // A later session loss stays in wallet mode. Only explicit disconnect opts back in.
  const mode = authorized ? "wallet" : selected;
  function disconnect() {
    void wallet.disconnect();
    setSelected("development");
  }
  return { mode, disconnect, busy: wallet.status === "connecting" || wallet.status === "disconnecting" };
}
