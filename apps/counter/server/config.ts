import {
  createPubkeyAccount,
  fromHex0x,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import {
  hex32,
  parseConfig,
  parseHttpUrl,
  type AppConfig,
} from "../src/config";

export interface ServerConfig {
  app: AppConfig;
  rpcUrl: string;
  signingPrivateKey: string;
}
export function loadServerConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  if (!env.COUNTER_SIGNING_PRIVATE_KEY && env.COUNTER_DEVELOPMENT_PRIVATE_KEY) {
    throw new Error(
      "Run setup:local to replace the previously public development signer.",
    );
  }
  const signingPrivateKey = hex32(
    env.COUNTER_SIGNING_PRIVATE_KEY,
    "Server signing key",
  );
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(fromHex0x(signingPrivateKey)),
  });
  return {
    app: parseConfig({
      networkId: env.VITE_GROUNDHOG_NETWORK_ID,
      counterAddress: env.VITE_COUNTER_ADDRESS,
      signerAddress: toHex0x(account.address),
      explorerUrl: env.VITE_EXPLORER_URL,
    }),
    rpcUrl: parseHttpUrl(env.VITE_GROUNDHOG_RPC_URL ?? "http://127.0.0.1:9545")
      .href,
    signingPrivateKey,
  };
}
