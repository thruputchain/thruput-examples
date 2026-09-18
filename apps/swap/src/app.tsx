import { BrowserRouter } from "react-router-dom";
import { AppProviders as PageProviders, BrowserConfiguredApp } from "./routes";
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
    <AppProviders client={client}>
      <PageProviders explorerUrl={config.explorerUrl}>
        <BrowserRouter>
          <BrowserConfiguredApp config={config} />
        </BrowserRouter>
      </PageProviders>
    </AppProviders>
  );
}
