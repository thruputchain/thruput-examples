import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  defineCluster,
  hashFromBase58,
  PrivateKeySigner,
  toBase58,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { prepareContractDeployment } from "@thruputchain/client/wallet";
import { HOG_ADDRESS, networkHash } from "@thruputchain/protocol";
import { GAS, methods } from "../src/contracts/polls";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export async function localClient() {
  const url = new URL(process.env.THRUPUT_RPC_URL || "http://127.0.0.1:9545");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Use a loopback HTTP RPC endpoint.");
  if (!process.env.THRUPUT_RUNTIME_MANIFEST)
    throw new Error(
      "Set THRUPUT_RUNTIME_MANIFEST to the path printed by thruput node.",
    );
  const manifest = JSON.parse(
    await readFile(resolve(root, process.env.THRUPUT_RUNTIME_MANIFEST), "utf8"),
  ) as { networkHash: string };
  return createThruputClient({
    cluster: defineCluster({
      name: "local",
      rpcUrl: url.href,
      networkHash: networkHash(hashFromBase58(manifest.networkHash)),
      capabilities: ["airdrop"] as const,
    }),
  });
}

export async function deployVoting(
  client: Awaited<ReturnType<typeof localClient>>,
) {
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  const funding = await wallet.requestAirdrop();
  if (funding.status.result !== "ok")
    throw new Error("Deployer funding failed.");
  const contract = await readFile(resolve(root, "target/thruput/voting.rv32a"));
  const deployment = prepareContractDeployment({
    deployer: account.address,
    contract,
  });
  // A teaching deployment has a finite shared storage budget. The balance API
  // makes that budget visible; users need free HOG for their own scheduling gas.
  console.log(
    `Deployer balance: ${(await wallet.getBalance()).rawBalance} raw HOG`,
  );
  const funded = await wallet.executeAndWait(
    {
      gasLimit: GAS,
      invocation: ERC20.v0_1.transfer.invocation(HOG_ADDRESS, GAS, {
        receiver: deployment.address,
        amount: 10_000_000n,
      }),
    },
    {
      timeoutMs: 60_000,
    },
  );
  console.log(`Funding transaction: ${toBase58(funded.txHash)}`);
  const { txHash } = await wallet.deployContractAndWait(
    deployment,
    { gasLimit: GAS, amount: 0n },
    { timeoutMs: 60_000 },
  );
  console.log(`Deployment transaction: ${toBase58(txHash)}`);
  const count = await methods.count.view({
    client,
    contract: deployment.address,
  });
  if (count.value !== 0n)
    throw new Error("Expected a fresh empty Voting deployment.");
  return deployment.address;
}

async function main() {
  const client = await localClient();
  const address = await deployVoting(client);
  const output = fileURLToPath(new URL("../.env.local", import.meta.url));
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporary,
      [
        `THRUPUT_RPC_URL=${process.env.THRUPUT_RPC_URL || "http://127.0.0.1:9545"}`,
        `VITE_THRUPUT_NETWORK_ID=${toBase58(client.network.networkHash)}`,
        `VITE_VOTING_ADDRESS=${toBase58(address)}`,
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, output);
    console.log(`Voting ready: ${toBase58(address)}\nEnvironment: ${output}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
