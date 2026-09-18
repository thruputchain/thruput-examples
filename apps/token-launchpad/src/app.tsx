import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppConfig } from "@/config";
import { WalletProvider } from "@/wallet/wallet-provider";
import { WalletInstallBanner } from "@/wallet/wallet-install-banner";
import { LaunchpadRoutes } from "./routes";
import { workflowStorageKey } from "./launch/workflow";

export function App({ config }: { config: AppConfig }) {
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
