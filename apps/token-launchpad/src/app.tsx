import { BrowserRouter } from "react-router-dom";
import type { AppConfig } from "@/config";
import { AppProviders } from "@/app-providers";
import type { ConnectedGroundhogClient } from "@groundhogchain/client";
import { AppLayout } from "./app-layout";
import { AppRoutes } from "./routes";

export function App({
  config,
  client,
}: {
  config: AppConfig;
  client: ConnectedGroundhogClient;
}) {
  return (
    <AppProviders client={client} explorerUrl={config.explorerUrl}>
      <BrowserRouter>
        <AppLayout>
          <AppRoutes config={config} />
        </AppLayout>
      </BrowserRouter>
    </AppProviders>
  );
}
