import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bytesEqual,
  fromHex0x,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";

const KNOWN_DEV_WALLET_HASH =
  "0xc57f839d14635aac9e7bd60327dd2280a68a4f891eff815cfc80461de3649b7d";
const PERSONAS = [
  { id: "alice", label: "Alice" },
  { id: "bob", label: "Bob" },
  { id: "carol", label: "Carol" },
] as const;

interface RuntimeManifest {
  readonly networkHash: string;
  readonly bootstrapAccountDerivation: { readonly seed: string };
  readonly bootstrapAccounts: readonly {
    readonly index: number;
    readonly role: "faucet" | "local_user";
    readonly publicKey: string;
    readonly walletAddress: string;
  }[];
  readonly bootstrap: {
    readonly devWallet: {
      readonly contentHash: string;
      readonly doActionEntrypoint: string;
    };
  };
}

async function main(): Promise<void> {
  const manifestPath = required("GROUNDHOG_RUNTIME_MANIFEST");
  const rpcUrl = loopbackOrigin(
    required("GROUNDHOG_RPC_URL"),
    "GROUNDHOG_RPC_URL",
  );
  const indexerUrl = loopbackOrigin(
    required("GAME_OF_LIFE_INDEXER_URL"),
    "GAME_OF_LIFE_INDEXER_URL",
  );
  const contractAddress = required("GROUNDHOG_CONTRACT_ADDRESS");
  if (!/^0x[0-9a-f]{64}$/.test(contractAddress))
    throw new Error(
      "GROUNDHOG_CONTRACT_ADDRESS must be canonical lowercase hex32",
    );
  const manifest = JSON.parse(
    await readFile(resolve(manifestPath), "utf8"),
  ) as RuntimeManifest;
  if (
    !/^[0-9a-f]{64}$/.test(manifest.networkHash) ||
    manifest.bootstrap.devWallet.contentHash !== KNOWN_DEV_WALLET_HASH ||
    !/^0x[0-9a-f]{16}$/.test(manifest.bootstrap.devWallet.doActionEntrypoint)
  )
    throw new Error(
      "Runtime manifest does not expose the verified local DevWallet implementation",
    );
  const users = manifest.bootstrapAccounts.filter(
    ({ role }) => role === "local_user",
  );
  if (users.length < PERSONAS.length)
    throw new Error(
      "The local node must expose Alice, Bob, and Carol accounts",
    );
  const personas = PERSONAS.map((identity, offset) => {
    const account = users[offset]!;
    const privateKey = createHash("sha256")
      .update(
        `${manifest.bootstrapAccountDerivation.seed}:account-${account.index}`,
      )
      .digest();
    const signer = new PrivateKeySigner(privateKey);
    if (!bytesEqual(signer.publicKey.ed25519, fromHex0x(account.publicKey)))
      throw new Error(`${identity.label}'s signer does not match the manifest`);
    if (!/^0x[0-9a-f]{64}$/.test(account.walletAddress))
      throw new Error(`${identity.label}'s wallet root is invalid`);
    return {
      ...identity,
      privateKey: toHex0x(privateKey),
      signerPublicKey: account.publicKey,
      walletRoot: account.walletAddress,
      walletEntrypoint: manifest.bootstrap.devWallet.doActionEntrypoint,
      expectedCaller: account.walletAddress,
      // The pinned DevWallet's doAction invokes the target as its own root address.
      callerVerified: true,
    };
  });
  const output = [
    `VITE_GROUNDHOG_RPC_URL=${rpcUrl}`,
    `VITE_GROUNDHOG_NETWORK_ID=${manifest.networkHash}`,
    `VITE_GAME_OF_LIFE_CONTRACT_ADDRESS=${contractAddress}`,
    `VITE_GAME_OF_LIFE_INDEXER_URL=${indexerUrl}`,
    "VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT=100000",
    "VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT=100000",
    "VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS=64",
    "VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS=30000",
    "VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT=10010000000",
    "VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT=10000000000",
    "VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS=2",
    "VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS=300000",
    `GROUNDHOG_DEV_PERSONAS=${JSON.stringify(personas)}`,
    "",
  ].join("\n");
  const destination = resolve(import.meta.dirname, "../.env.local");
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, output, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  process.stdout.write(
    `Wrote verified loopback configuration to ${destination}\n`,
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loopbackOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be a credential-free loopback origin root`);
  return url.href.replace(/\/$/, "");
}

await main();
