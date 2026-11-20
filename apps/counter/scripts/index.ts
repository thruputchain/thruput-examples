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
  toHex0x,
  type ContractDeployment,
} from "@thruputchain/client";
import { gasAmount, networkHash } from "@thruputchain/protocol";
import {
  errorMessage,
  hash58,
  parseConfig,
  type AppConfig,
} from "../src/config";
import { Counter } from "../src/contracts/generated/counter";
import {
  createPersona,
  createRun,
  record,
  saveRun,
  type Client,
  type Persona,
  type Run,
} from "./run";

const initialValue = 1_000_000n;
const callGas = gasAmount(500_000n); // Limits the inner initialization call.
const deploymentGas = gasAmount(10_000_000n); // Covers the wallet, deployment, and initializer.
// One native token supports this Counter's code and state; storage funding is separate from gas.
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
): Promise<void> {
  const defaults = networks[network];
  let networkId =
    env.THRUPUT_NETWORK_ID === undefined
      ? undefined
      : hash58(env.THRUPUT_NETWORK_ID, "THRUPUT_NETWORK_ID");
  // A manifest is optional. If supplied, retain its expected-network check.
  if (env.THRUPUT_RUNTIME_MANIFEST) {
    const manifest: { networkHash?: unknown } = JSON.parse(
      await readFile(
        resolve(repositoryRoot, env.THRUPUT_RUNTIME_MANIFEST),
        "utf8",
      ),
    );
    const recorded = hash58(manifest.networkHash, "Runtime network hash");
    if (networkId !== undefined && networkId !== recorded) {
      throw new Error("Runtime manifest and THRUPUT_NETWORK_ID disagree.");
    }
    networkId = recorded;
  }
  await provisionCounter({
    network,
    rpcUrl: env.THRUPUT_RPC_URL ?? defaults.rpcUrl,
    networkId,
    output:
      env.COUNTER_APP_ENV ||
      fileURLToPath(new URL(defaults.output, import.meta.url)),
    artifact: env.COUNTER_ARTIFACT,
    explorerUrl: env.VITE_EXPLORER_URL,
  });
}

interface Options {
  network: "local" | "devnet";
  rpcUrl: string;
  networkId?: string | undefined;
  output: string;
  artifact?: string | undefined;
  explorerUrl?: string | undefined;
}

/** Create a fresh Counter and publish its environment after verification. */
export async function provisionCounter(options: Options): Promise<void> {
  const contract = await readFile(
    resolve(repositoryRoot, options.artifact || "target/thruput/counter.rv32a"),
  );
  // The SDK discovers network identity and checks an explicit pin before signing.
  const client = await createThruputClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl: options.rpcUrl,
      capabilities: ["airdrop"] as const,
      ...(options.networkId === undefined
        ? {}
        : {
            networkHash: networkHash(hashFromBase58(options.networkId)),
          }),
    }),
    transport: new HttpTransport(options.rpcUrl, { timeoutMs: 15_000 }),
  });
  const output = resolve(repositoryRoot, options.output);
  const run = await createRun(
    join(dirname(output), ".local", "counter-setup"),
    toBase58(client.network.networkHash),
  );
  console.log(`Run: ${run.directory}`);
  try {
    const persona = await createPersona(client, run, "Counter Operator");
    const deployment = prepareContractDeployment({
      deployer: persona.account.address,
      contract,
    });
    const config = parseConfig({
      networkId: run.manifest.networkHash,
      counterAddress: toBase58(deployment.address),
      signerAddress: persona.address,
      explorerUrl: options.explorerUrl,
    });
    // Keep the predicted address even if deployment confirmation fails.
    run.manifest.counterAddress = config.counterAddress;
    await saveRun(run);

    // Await each step: later operations depend on earlier confirmations.
    await fundPersona(run, persona);
    await deployCounter(run, persona, deployment);
    await verifyCounter(client, run, persona, deployment);
    await writeEnvironment(output, options.rpcUrl, config, persona.seed);
    run.manifest.status = "complete";
    await saveRun(run);
    console.log(
      `Counter ready at ${config.counterAddress}\nSigner: ${persona.address}\nEnvironment: ${output}`,
    );
  } catch (error) {
    run.manifest.status = "failed";
    run.manifest.error = error instanceof Error ? error.message : String(error);
    await saveRun(run);
    throw error;
  }
}

async function fundPersona(run: Run, persona: Persona) {
  await record(run, `Fund ${persona.name}`, async () => {
    // The faucet chooses the amount and waits for successful execution.
    const funding = await persona.wallet.requestAirdrop(wait);
    return {
      hash: funding.transactionHash,
      blockHeight: funding.blockHeight,
    };
  });
}

async function deployCounter(
  run: Run,
  persona: Persona,
  deployment: ContractDeployment,
) {
  await record(run, "Deploy and initialize Counter", () =>
    // Funding, deployment, and initialization succeed or fail together.
    persona.wallet.deployContractAndWait(
      deployment,
      {
        gasLimit: deploymentGas,
        amount: storageFunding,
        initializer: Counter.v0_1.initialize.invocation(
          deployment.address,
          callGas,
          { initialValue },
        ),
      },
      wait,
    ),
  );
}

async function verifyCounter(
  client: Client,
  run: Run,
  persona: Persona,
  deployment: ContractDeployment,
) {
  // Require a snapshot containing our last confirmed write, not an older state.
  const result = await Counter.v0_1.get.view({
    client,
    address: deployment.address,
    caller: persona.account.address,
    minStateBlockHeight: run.latestBlockHeight,
  });
  // Expected state comes from scenario input, independently of transaction results.
  if (result.value !== initialValue) {
    throw new Error(
      `Counter verification failed: expected ${initialValue}, received ${result.value}.`,
    );
  }
}

async function writeEnvironment(
  output: string,
  rpcUrl: string,
  config: AppConfig,
  seed: Uint8Array,
) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporary,
      [
        `VITE_THRUPUT_RPC_URL=${rpcUrl}`,
        `VITE_THRUPUT_NETWORK_ID=${config.networkId}`,
        `VITE_COUNTER_ADDRESS=${config.counterAddress}`,
        `COUNTER_SIGNING_PRIVATE_KEY=${toHex0x(seed)}`,
        `VITE_EXPLORER_URL=${config.explorerUrl ?? ""}`,
        "PORT=3000",
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
    // Publish only after verification, keeping the previous environment on setup failure.
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

// Tests import setup without contacting a node; only direct invocation runs the CLI.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
