import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppConfig } from "@/config";
import { AppProviders } from "@/app-providers";
import type { ConnectedGroundhogClient } from "@groundhogchain/client";
import { WalletInstallBanner } from "@/wallet/wallet-controls";
import { LaunchpadRoutes } from "./routes";

export function App({
  config,
  client,
}: {
  config: AppConfig;
  client: ConnectedGroundhogClient;
}) {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <AppProviders client={client}>
          <WalletInstallBanner />
          <LaunchpadRoutes config={config} />
        </AppProviders>
      </BrowserRouter>
    </TooltipProvider>
  );
}
