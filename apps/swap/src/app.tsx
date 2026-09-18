import { BrowserRouter } from "react-router-dom";
import { AppProviders, BrowserConfiguredApp } from "./routes";
import type { GlobalConfig } from "./config";

export function App({ config }: { config: GlobalConfig }) {
  return <AppProviders explorerUrl={config.explorerUrl}>
    <BrowserRouter><BrowserConfiguredApp config={config} /></BrowserRouter>
  </AppProviders>;
}
