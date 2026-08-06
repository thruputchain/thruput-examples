import { AlertTriangleIcon, LockKeyholeIcon } from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfigurationError, loadAppConfig } from "@/config";

export function App() {
  const configuration = readConfiguration();

  return (
    <main className="min-h-svh bg-background text-foreground">
      <section className="mx-auto flex min-h-svh max-w-3xl items-center px-6 py-16">
        <div className="flex w-full flex-col gap-6">
          <p className="text-sm font-medium text-muted-foreground">
            Local development
          </p>
          <div className="flex flex-col gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              Groundhog Swap
            </h1>
            <p className="max-w-xl text-muted-foreground">
              Application foundations are ready for the read-only swap
              experience.
            </p>
          </div>
          <Alert>
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>Local-development environment</AlertTitle>
            <AlertDescription>
              State-changing actions remain unavailable until direct pubkey
              authorization is integrated. Never use the generated development
              credentials on a public network.
            </AlertDescription>
          </Alert>
          {configuration.ok ? (
            <p className="text-sm text-muted-foreground">
              Configured account {abbreviate(configuration.account)}
            </p>
          ) : (
            <p className="text-sm text-destructive" role="alert">
              {configuration.message}
            </p>
          )}
          <Button disabled className="self-start">
            <LockKeyholeIcon data-icon="inline-start" />
            Swaps unavailable
          </Button>
        </div>
      </section>
    </main>
  );
}

function readConfiguration():
  | { ok: true; account: Uint8Array }
  | { ok: false; message: string } {
  try {
    const config = loadAppConfig({
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
    });
    return { ok: true, account: config.accountAddress };
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

function abbreviate(address: Uint8Array): string {
  const hex = Array.from(address, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `0x${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
