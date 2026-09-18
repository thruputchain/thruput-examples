import { useMemo, useState, type ReactNode } from "react";
import { addressFromHex } from "@groundhogchain/client";
import {
  WalletProvider as GroundhogWalletProvider,
  useClient,
  useWallet,
  useWalletClient,
} from "@groundhogchain/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { AppHeader } from "@/components/app-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { publicConfigKey, READ_ONLY_CALLER, type GlobalConfig } from "@/config";
import { createNetworkReadClient } from "@/groundhog/client";
import { createProviderWriteBoundary } from "@/transactions/provider-wallet";
import { WalletWriteContext } from "./write-context";

interface WalletProviderProps {
  config: GlobalConfig;
  children: (
    config: GlobalConfig,
    connected: boolean,
    revision: number,
  ) => ReactNode;
}

export function WalletProvider(props: WalletProviderProps) {
  return <AppQueries key={publicConfigKey(props.config)} {...props} />;
}

function AppQueries(props: WalletProviderProps) {
  const [queries] = useState(() => new QueryClient());
  const [config] = useState(props.config);
  return (
    <QueryClientProvider client={queries}>
      <ConnectClient {...props} config={config} />
    </QueryClientProvider>
  );
}

function ConnectClient(props: WalletProviderProps) {
  const client = useQuery({
    queryKey: ["public-client"],
    queryFn: () => createNetworkReadClient(props.config),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (!client.data)
    return (
      <>
        <AppHeader product="Swap" />
        <main className="mx-auto max-w-5xl p-6">
          {client.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not connect to Groundhog</AlertTitle>
              <AlertDescription>
                <p>{client.error.message}</p>
                <Button
                  variant="outline"
                  disabled={client.isFetching}
                  onClick={() => void client.refetch()}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <p role="status">Connecting to Groundhog…</p>
          )}
        </main>
      </>
    );
  return (
    <GroundhogWalletProvider client={client.data}>
      <WalletRuntime {...props} />
    </GroundhogWalletProvider>
  );
}

function WalletRuntime({ config: base, children }: WalletProviderProps) {
  const client = useClient();
  const wallet = useWallet();
  const signingClient = useWalletClient();
  const connected = wallet.status === "connected";
  const address = connected ? wallet.address : null;
  const config = useMemo(
    () => ({
      ...base,
      accountAddress: address ? addressFromHex(address) : READ_ONLY_CALLER,
    }),
    [base, address],
  );
  const writer = useMemo(
    () =>
      createProviderWriteBoundary(config, client, signingClient ?? undefined),
    [config, client, signingClient],
  );
  // Existing route forms reset when the signing binding changes, even for the same account.
  const [scope, setScope] = useState({ binding: signingClient, revision: 0 });
  if (scope.binding !== signingClient)
    setScope({ binding: signingClient, revision: scope.revision + 1 });
  return (
    <WalletWriteContext value={writer}>
      {children(config, connected, scope.revision)}
    </WalletWriteContext>
  );
}
