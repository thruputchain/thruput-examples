import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider } from "@thruputchain/react";
import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import { App } from "./app";
import {
  address,
  hash,
  parseTokens,
  type PublicConfig,
} from "../shared/config";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
async function main() {
  const response = await fetch(`${import.meta.env.BASE_URL}api/config`);
  if (!response.ok) throw new Error("Could not load Airdrop configuration.");
  const value = (await response.json()) as PublicConfig;
  const config = {
    ...value,
    address: address(value.address),
    networkId: hash(value.networkId),
    anchorHash: hash(value.anchorHash),
    tokens: parseTokens(value.tokens),
  };
  const client = await createThruputClient({
    cluster: defineCluster({
      name: "airdrop",
      rpcUrl: new URL(`${import.meta.env.BASE_URL}thruput-rpc`, location.origin)
        .href,
      networkHash: networkHash(hashFromBase58(config.networkId)),
      capabilities: [],
    }),
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  root.render(
    <StrictMode>
      <QueryClientProvider client={queries}>
        <WalletProvider client={client}>
          <App config={config} />
        </WalletProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
main().catch((error) =>
  root.render(
    <main>
      <h1>Airdrop setup</h1>
      <p role="alert">
        {error instanceof Error ? error.message : "Could not load Airdrop."}
      </p>
    </main>,
  ),
);
