import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider } from "@thruputchain/react";
import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import { App } from "./app";
import { errorMessage, parseConfig } from "./config";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
async function main() {
  const response = await fetch(`${import.meta.env.BASE_URL}api/config`);
  if (!response.ok) throw new Error("Could not load the Voting configuration.");
  const config = parseConfig(await response.json());
  const client = await createThruputClient({
    cluster: defineCluster({
      name: "local",
      rpcUrl: new URL(`${import.meta.env.BASE_URL}thruput-rpc`, location.origin)
        .href,
      networkHash: networkHash(hashFromBase58(config.networkId)),
      capabilities: [] as const,
    }),
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  root.render(
    <StrictMode>
      <QueryClientProvider client={queries}>
        <WalletProvider client={client}>
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            <App config={config} />
          </BrowserRouter>
        </WalletProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
main().catch((error) =>
  root.render(
    <main>
      <h1>Voting setup</h1>
      <p role="alert">{errorMessage(error)}</p>
      <button type="button" onClick={() => location.reload()}>
        Try again
      </button>
    </main>,
  ),
);
