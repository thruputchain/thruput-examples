import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { AppLayout } from "./app-layout";
import { AppProviders } from "./app-providers";
import type { ConnectedThruputClient } from "@thruputchain/client";
import type { AppConfig } from "./config";

export function App({
  config,
  client,
}: {
  config: AppConfig;
  client: ConnectedThruputClient;
}) {
  return (
    <AppProviders client={client} explorerUrl={config.explorerUrl}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AppLayout>
          <AppRoutes config={config} />
        </AppLayout>
      </BrowserRouter>
    </AppProviders>
  );
}
