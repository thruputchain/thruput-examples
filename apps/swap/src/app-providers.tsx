import { useState, type ReactNode } from "react";
import type { ConnectedGroundhogClient } from "@groundhogchain/client";
import { WalletProvider } from "@groundhogchain/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ExplorerProvider } from "@/components/explorer-context";
import { ProcessingModeProvider } from "@/components/processing-mode";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";

// One foreground listener for all app queries, including returning from a wallet popup.
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
  client: ConnectedGroundhogClient;
  explorerUrl?: string | undefined;
  children: ReactNode;
}) {
  const [queries] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queries}>
      <WalletProvider client={client}>
        <TooltipProvider>
          <ExplorerProvider value={explorerUrl}>
            <ProcessingModeProvider>{children}</ProcessingModeProvider>
          </ExplorerProvider>
        </TooltipProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}
