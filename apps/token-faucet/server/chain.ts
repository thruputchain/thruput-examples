import { readFile, stat } from "node:fs/promises";
import {
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  defineCluster,
  fromHex0x,
  HttpTransport,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { networkHash, sha256Hash } from "@groundhogchain/protocol";
import type { FaucetManifest } from "../src/domain.ts";

export async function loadFaucetAccount(
  keyPath: string,
  signingPrivateKey?: string,
) {
  let key: Uint8Array;
  if (signingPrivateKey !== undefined) {
    if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(signingPrivateKey)) {
      throw new Error(
        "FAUCET_SIGNING_PRIVATE_KEY must be a 32-byte hexadecimal key.",
      );
    }
    key = fromHex0x(`0x${signingPrivateKey.replace(/^0x/, "")}`);
  } else {
    const metadata = await stat(keyPath);
    if ((metadata.mode & 0o077) !== 0)
      throw new Error("The faucet key file must have mode 0600.");
    key = await readFile(keyPath);
    if (key.length !== 32)
      throw new Error("The faucet key file must contain 32 bytes.");
  }
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(new Uint8Array(key)),
  });
  key.fill(0);
  return account;
}

export async function connectChain(
  manifest: Pick<FaucetManifest, "network" | "rpcUrl" | "account">,
  keyPath: string,
  signingPrivateKey?: string,
) {
  const account = await loadFaucetAccount(keyPath, signingPrivateKey);
  if (toHex0x(account.address) !== manifest.account)
    throw new Error("Faucet signer does not match the deployment.");
  const client = await createGroundhogClient({
    cluster: defineCluster({
      name: "devnet",
      rpcUrl: manifest.rpcUrl,
      networkHash: networkHash(sha256Hash(fromHex0x(manifest.network))),
      capabilities: ["airdrop"] as const,
    }),
    transport: new HttpTransport(manifest.rpcUrl, { timeoutMs: 10_000 }),
  });
  const verifyNetwork = async () => {
    if (
      toHex0x((await client.getNetworkInfo()).networkHash) !== manifest.network
    ) {
      throw new Error("The RPC network does not match the faucet deployment.");
    }
  };
  await verifyNetwork();
  return {
    client,
    account,
    wallet: createWalletClient({ client, account }),
    verifyNetwork,
  };
}
