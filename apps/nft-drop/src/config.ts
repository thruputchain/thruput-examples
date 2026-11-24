import { addressFromBase58, hashFromBase58 } from "@thruputchain/client";

/** Public configuration. The server sends these values to the browser. */
export function parseConfig(env: Record<string, string | undefined>) {
  const networkId = env.VITE_THRUPUT_NETWORK_ID;
  const factory = env.VITE_NFT_DROP_FACTORY;
  if (!networkId || !factory)
    throw new Error(
      "Run setup:local for the NFT Drop app, then restart the app.",
    );
  hashFromBase58(networkId);
  // How many simulated users the server can run a rush with; 0 disables it.
  const crowdSize = Number(env.NFT_CROWD_SIZE ?? 0);
  if (!Number.isInteger(crowdSize) || crowdSize < 0)
    throw new Error("NFT_CROWD_SIZE must be a whole number.");
  return { networkId, factory: addressFromBase58(factory), crowdSize };
}

export type AppConfig = ReturnType<typeof parseConfig>;

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";
