import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
  HttpTransport,
  parseUnits,
  prepareContractDeployment,
  toBase58,
  type ContractDeployment,
} from "@thruputchain/client";
import { gasAmount, networkHash } from "@thruputchain/protocol";
import { errorMessage } from "../src/config";
import { parseRpcUrl } from "../server/config";
import { Voting } from "../src/contracts/generated/voting";
import {
  createPersona,
  createRun,
  record,
  saveRun,
  type Client,
  type Persona,
  type Run,
} from "./run";

const deploymentGas = gasAmount(10_000_000n); // Covers the wallet, funding, and deployment.
// One native token funds code and poll storage. This is separate from gas capacity.
const storageFunding = parseUnits("1", 7);
const wait = { timeoutMs: 60_000 };
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const networks = {
  local: { rpcUrl: "http://127.0.0.1:9545", output: "../.env.local" },
  devnet: { rpcUrl: "https://rpc.thruput.network", output: "../.env.devnet" },
};

export async function setup(
  env: Record<string, string | undefined> = process.env,
  network: keyof typeof networks = "local",
) {
  const defaults = networks[network];
  let networkId =
    env.THRUPUT_NETWORK_ID === undefined
      ? undefined
      : toBase58(hashFromBase58(env.THRUPUT_NETWORK_ID));
  // A manifest is optional; an explicit expected network is still checked.
  if (env.THRUPUT_RUNTIME_MANIFEST) {
    const manifest: { networkHash?: string } = JSON.parse(
      await readFile(
        resolve(repositoryRoot, env.THRUPUT_RUNTIME_MANIFEST),
        "utf8",
      ),
    );
    const recorded = toBase58(hashFromBase58(manifest.networkHash ?? ""));
    if (networkId !== undefined && networkId !== recorded) {
      throw new Error("Runtime manifest and THRUPUT_NETWORK_ID disagree.");
    }
    networkId = recorded;
  }
  return provisionVoting({
    network,
    rpcUrl: env.THRUPUT_RPC_URL ?? defaults.rpcUrl,
    networkId,
    output:
      env.VOTING_APP_ENV ||
      fileURLToPath(new URL(defaults.output, import.meta.url)),
    artifact: env.VOTING_ARTIFACT,
  });
}

interface Options {
  network: "local" | "devnet";
  rpcUrl: string;
  networkId?: string | undefined;
  output: string;
  artifact?: string | undefined;
}

/** Deploy fresh Voting state and publish configuration after verification. */
export async function provisionVoting(options: Options) {
  const rpcUrl = parseRpcUrl(options.rpcUrl);
  const contract = await readFile(
    resolve(repositoryRoot, options.artifact || "target/thruput/voting.rv32a"),
  );
  // Discover network identity; pin it only when an expected hash was supplied.
  const client = await createThruputClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl,
      capabilities: ["airdrop"] as const,
      ...(options.networkId === undefined
        ? {}
        : {
            networkHash: networkHash(hashFromBase58(options.networkId)),
          }),
    }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 15_000 }),
  });
  const output = resolve(repositoryRoot, options.output);
  const run = await createRun(
    join(dirname(output), ".local", "voting-setup"),
    toBase58(client.network.networkHash),
  );
  console.log(`Run: ${run.directory}`);
  try {
    const persona = await createPersona(client, run, "Voting Deployer");
    const deployment = prepareContractDeployment({
      deployer: persona.account.address,
      contract,
    });
    // Keep the predicted address even when deployment confirmation fails.
    run.manifest.votingAddress = toBase58(deployment.address);
    await saveRun(run);

    // Await each step: verification must include the confirmed deployment.
    await fundPersona(run, persona);
    await deployVoting(run, persona, deployment);
    await verifyVoting(client, run, deployment);
    await writeEnvironment(output, options.rpcUrl, run);
    run.manifest.status = "complete";
    await saveRun(run);
    console.log(
      `Voting ready: ${run.manifest.votingAddress}\nEnvironment: ${output}`,
    );
    return { client, address: deployment.address };
  } catch (error) {
    run.manifest.status = "failed";
    run.manifest.error = errorMessage(error);
    await saveRun(run);
    throw error;
  }
}

async function fundPersona(run: Run, persona: Persona) {
  await record(run, `Fund ${persona.name}`, async () => {
    // The faucet chooses the amount and waits for successful execution.
    const funding = await persona.wallet.requestAirdrop(wait);
    return { hash: funding.transactionHash, blockHeight: funding.blockHeight };
  });
}

async function deployVoting(
  run: Run,
  persona: Persona,
  deployment: ContractDeployment,
) {
  await record(run, "Deploy Voting", () =>
    // Funding and deployment are atomic. Voting has no initializer.
    persona.wallet.deployContractAndWait(
      deployment,
      {
        gasLimit: deploymentGas,
        amount: storageFunding,
      },
      wait,
    ),
  );
}

async function verifyVoting(
  client: Client,
  run: Run,
  deployment: ContractDeployment,
) {
  const count = await Voting.v0_1.count.view({
    client,
    address: deployment.address,
    // Reject stale snapshots that do not yet contain the deployment.
    minStateBlockHeight: run.latestBlockHeight,
  });
  // A fresh deployment has no polls; this expectation is independent of the receipt.
  if (count.value !== 0n) {
    throw new Error(
      `Voting verification failed: expected 0 polls, received ${count.value}.`,
    );
  }
}

async function writeEnvironment(output: string, rpcUrl: string, run: Run) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporary,
      [
        `THRUPUT_RPC_URL=${rpcUrl}`,
        `VITE_THRUPUT_NETWORK_ID=${run.manifest.networkHash}`,
        `VITE_VOTING_ADDRESS=${run.manifest.votingAddress}`,
        "PORT=3000",
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
    // Publish only after verification. Setup failure keeps the previous environment.
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: { network: { type: "string", default: "local" } },
  });
  if (values.network !== "local" && values.network !== "devnet") {
    throw new Error("Use --network local or --network devnet.");
  }
  await setup(process.env, values.network);
}

// Importing setup in tests does not contact a node.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
