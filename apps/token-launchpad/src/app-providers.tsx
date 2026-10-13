import { useState, type ReactNode } from "react";
import type { ConnectedThruputClient } from "@thruputchain/client";
import { WalletProvider } from "@thruputchain/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ExplorerProvider } from "@/components/explorer-context";
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
  explorerUrl,
  children,
}: {
  client: ConnectedThruputClient;
  explorerUrl?: string | null | undefined;
  children: ReactNode;
}) {
  const [queries] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queries}>
      <WalletProvider client={client}>
        <TooltipProvider>
          <ExplorerProvider value={explorerUrl ?? undefined}>
            {children}
          </ExplorerProvider>
        </TooltipProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}
