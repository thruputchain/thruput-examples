import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { AppLayout } from "./app-layout";
import { AppProviders } from "./app-providers";
import type { ConnectedGroundhogClient } from "@groundhogchain/client";
import type { GlobalConfig } from "./config";

export function App({
  config,
  client,
}: {
  config: GlobalConfig;
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
