import { AlertCircleIcon } from "lucide-react";
import { useState } from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ConfigurationError,
  loadAppConfig,
  type AppConfig,
} from "@/config";
import {
  createSnapshotReader,
  type SnapshotReader,
} from "@/swap/snapshot";
import { SwapPage } from "@/swap/swap-page";

export function App({
  config: suppliedConfig,
  readSnapshot,
}: {
  config?: AppConfig;
  readSnapshot?: SnapshotReader;
} = {}) {
  const configuration = suppliedConfig
    ? { ok: true as const, config: suppliedConfig }
    : readBrowserConfiguration();

  if (!configuration.ok) {
    return <ConfigurationErrorPage message={configuration.message} />;
  }

  return (
    <ConfiguredApp
      config={configuration.config}
      readSnapshot={readSnapshot}
    />
  );
}

function ConfiguredApp({
  config,
  readSnapshot,
}: {
  config: AppConfig;
  readSnapshot: SnapshotReader | undefined;
}) {
  const [reader] = useState<SnapshotReader>(
    () => readSnapshot ?? createSnapshotReader(config),
  );
  return <SwapPage config={config} readSnapshot={reader} />;
}

function ConfigurationErrorPage({ message }: { message: string }) {
  return (
    <main className="isolate flex min-h-svh items-center bg-background px-4 py-12 text-foreground antialiased sm:px-6">
      <Card className="mx-auto w-full max-w-xl">
        <CardHeader>
          <CardTitle asChild>
            <h1>Configuration required</h1>
          </CardTitle>
          <CardDescription>
            Run the local setup command before starting the swap application.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>Generated configuration is unavailable</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </main>
  );
}

function readBrowserConfiguration():
  | { ok: true; config: AppConfig }
  | { ok: false; message: string } {
  try {
    return {
      ok: true,
      config: loadAppConfig({
        VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
        VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
        VITE_GROUNDHOG_WALLET_ADDRESS:
          import.meta.env.VITE_GROUNDHOG_WALLET_ADDRESS,
        VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
        VITE_SWAP_PAIR_ADDRESS: import.meta.env.VITE_SWAP_PAIR_ADDRESS,
        VITE_SWAP_HANDLER_ADDRESS: import.meta.env.VITE_SWAP_HANDLER_ADDRESS,
        VITE_SWAP_DRIVER_ADDRESS: import.meta.env.VITE_SWAP_DRIVER_ADDRESS,
        VITE_TOKEN_A_ADDRESS: import.meta.env.VITE_TOKEN_A_ADDRESS,
        VITE_TOKEN_B_ADDRESS: import.meta.env.VITE_TOKEN_B_ADDRESS,
        VITE_TOKEN_A_SYMBOL: import.meta.env.VITE_TOKEN_A_SYMBOL,
        VITE_TOKEN_B_SYMBOL: import.meta.env.VITE_TOKEN_B_SYMBOL,
        VITE_TOKEN_DECIMALS: import.meta.env.VITE_TOKEN_DECIMALS,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof ConfigurationError
          ? error.message
          : "Application configuration is invalid",
    };
  }
}
