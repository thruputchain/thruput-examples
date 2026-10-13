import {
  createPubkeyAccount,
  fromHex0x,
  PrivateKeySigner,
  toHex0x,
} from "@thruputchain/client";
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
  const signingPrivateKey = hex32(
    env.COUNTER_SIGNING_PRIVATE_KEY,
    "Server signing key",
  );
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(fromHex0x(signingPrivateKey)),
  });
  return {
    app: parseConfig({
      networkId: env.VITE_THRUPUT_NETWORK_ID,
      counterAddress: env.VITE_COUNTER_ADDRESS,
      signerAddress: toHex0x(account.address),
      explorerUrl: env.VITE_EXPLORER_URL,
    }),
    rpcUrl: parseHttpUrl(env.VITE_THRUPUT_RPC_URL ?? "http://127.0.0.1:9545")
      .href,
    signingPrivateKey,
  };
}
