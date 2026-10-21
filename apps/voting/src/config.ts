import { addressFromBase58, hashFromBase58 } from "@thruputchain/client";

export function parseConfig(env: Record<string, string | undefined>) {
  const networkId = env.VITE_THRUPUT_NETWORK_ID;
  const address = env.VITE_VOTING_ADDRESS;
  if (!networkId || !address)
    throw new Error(
      "Run setup:local for the Voting app, then restart the app.",
    );
  hashFromBase58(networkId);
  return { networkId, address: addressFromBase58(address) };
}

export type AppConfig = ReturnType<typeof parseConfig>;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";
