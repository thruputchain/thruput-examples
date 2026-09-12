import { BrowserRouter } from "react-router-dom";
import {
  AppProviders,
  BrowserConfiguredApp,
  ConfigurationErrorPage,
  readBrowserConfiguration,
} from "./routes";

export function App() {
  const configuration = readBrowserConfiguration();
  return (
    <AppProviders
      explorerUrl={
        configuration.ok ? configuration.config.explorerUrl : undefined
      }
    >
      {configuration.ok ? (
        <BrowserRouter>
          <BrowserConfiguredApp config={configuration.config} />
        </BrowserRouter>
      ) : (
        <ConfigurationErrorPage message={configuration.message} />
      )}
    </AppProviders>
  );
}
