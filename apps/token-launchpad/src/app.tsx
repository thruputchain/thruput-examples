import { BrowserRouter } from "react-router-dom";
import { AppHeader } from "@/components/app-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TooltipProvider } from "@/components/ui/tooltip";
import { loadConfig, type AppConfig } from "@/config";
import { WalletProvider } from "@/wallet/wallet-provider";
import { WalletInstallBanner } from "@/wallet/wallet-install-banner";
import { LaunchpadRoutes } from "./routes";
import { workflowStorageKey } from "./launch/workflow";

export function App() {
  let config: AppConfig;
  try {
    config = loadConfig(import.meta.env);
  } catch (error) {
    return (
      <>
        <AppHeader product="Token Launchpad" />
        <main className="mx-auto max-w-5xl p-6">
          <Alert variant="destructive">
            <AlertTitle>Configuration required</AlertTitle>
            <AlertDescription>
              {error instanceof Error
                ? error.message
                : "Application configuration is invalid"}
            </AlertDescription>
          </Alert>
        </main>
      </>
    );
  }
  return (
    <TooltipProvider>
      <BrowserRouter>
        <WalletProvider config={config}>
          {(config, connected, hasWalletAccount) => (
            <>
              <WalletInstallBanner />
              <LaunchpadRoutes
                key={workflowStorageKey(config)}
                config={config}
                readOnly={!connected}
                hasWalletAccount={hasWalletAccount}
              />
            </>
          )}
        </WalletProvider>
      </BrowserRouter>
    </TooltipProvider>
  );
}
