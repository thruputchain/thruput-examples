import { useState, type ReactNode } from "react";
import type { ConnectedGroundhogClient } from "@groundhogchain/client";
import { WalletProvider } from "@groundhogchain/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";

focusManager.setEventListener((notify) => {
  if (typeof window === "undefined") return;
  const visible = () => notify();
  window.addEventListener("focus", visible);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener("focus", visible);
    document.removeEventListener("visibilitychange", visible);
  };
});

export function AppProviders({
  client,
  children,
}: {
  client: ConnectedGroundhogClient;
  children: ReactNode;
}) {
  const [queries] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queries}>
      <WalletProvider client={client}>{children}</WalletProvider>
    </QueryClientProvider>
  );
}
