import { parseConfig, parseHttpUrl, type AppConfig } from "../src/config";

export interface ServerConfig {
  app: AppConfig;
  rpcUrl: string;
}
export function loadServerConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  return {
    app: parseConfig({
      networkId: env.VITE_GROUNDHOG_NETWORK_ID,
      counterAddress: env.VITE_COUNTER_ADDRESS,
      developmentPrivateKey: env.COUNTER_DEVELOPMENT_PRIVATE_KEY,
      explorerUrl: env.VITE_EXPLORER_URL,
    }),
    rpcUrl: parseHttpUrl(env.VITE_GROUNDHOG_RPC_URL ?? "http://127.0.0.1:9545")
      .href,
  };
}
