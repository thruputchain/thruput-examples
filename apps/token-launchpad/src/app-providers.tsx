import { useState, type ReactNode } from "react";
import type { ConnectedGroundhogClient } from "@groundhogchain/client";
import { WalletProvider } from "@groundhogchain/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
