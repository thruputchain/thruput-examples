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
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import {
  createKeyFile,
  createOutputDirectory,
  loadArtifacts,
  withScenario,
} from "@thruputchain/testkit";
import { gasAmount, networkHash } from "@thruputchain/protocol";
import {
  errorMessage,
  hash58,
  parseConfig,
  type AppConfig,
} from "../src/config";
import { Counter } from "../src/contracts/generated/counter";

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
  const artifacts = await loadArtifacts({
    counter: resolve(
      repositoryRoot,
      options.artifact || "target/thruput/counter.rv32a",
    ),
  });
  const cluster = defineCluster({
    name: options.network,
    rpcUrl: options.rpcUrl,
    capabilities: ["airdrop"] as const,
    ...(options.networkId === undefined
      ? {}
      : {
          networkHash: networkHash(hashFromBase58(options.networkId)),
        }),
  });
  const transport = new HttpTransport(options.rpcUrl, { timeoutMs: 15_000 });
  // Preserve discovery and optional pins, then bind the scenario to this identity.
  const client = await createThruputClient({ cluster, transport });
  const output = resolve(repositoryRoot, options.output);
  const directory = await createOutputDirectory(
    join(dirname(output), ".local", "counter-setup"),
  );
  const runDirectory = join(directory, "transactions");
  console.log(`Report: ${join(runDirectory, "report.json")}`);
  // Save the private key before funding or deployment, so a failed run can be recovered.
  const operator = await createKeyFile(join(directory, "key.json"));
  const deployment = artifacts.counter.prepare(operator.account.address);
  const config = await withScenario(
    {
      network: {
        cluster: {
          ...cluster,
          networkHash: networkHash(
            hashFromBase58(toBase58(client.network.networkHash)),
          ),
        },
        transport,
      },
      accounts: { "Counter Operator": operator.account },
      runDirectory,
    },
    async (scenario) => {
      const actor = scenario.actor("Counter Operator");
      const config = parseConfig({
        networkId: scenario.run.report().networkHash,
        counterAddress: toBase58(deployment.address),
        signerAddress: operator.address,
        explorerUrl: options.explorerUrl,
      });
      console.log(
        `Signer: ${operator.address}\nPredicted Counter: ${config.counterAddress}`,
      );
      try {
        // The faucet chooses the amount. The report records the request and its hash.
        await scenario.run.step("fund-operator", () =>
          actor.fund({ timeoutMs: wait.timeoutMs }),
        );
        await scenario.run.step(
          "deploy-counter",
          () =>
            actor.deploy(deployment, {
              gasLimit: deploymentGas,
              amount: storageFunding,
              wait,
              // Funding, deployment, and initialization succeed or fail together.
              initializer: Counter.v0_1.initialize.call({
                address: deployment.address,
                gasLimit: callGas,
                args: { initialValue },
              }),
            }),
          {
            metadata: {
              address: config.counterAddress,
              initialValue: initialValue.toString(),
            },
          },
        );
        await scenario.run.step("verify-counter", async () => {
          // Testkit reads a snapshot containing the confirmed deployment.
          const result = await scenario.view(
            Counter.v0_1.get.viewRequest({
              address: deployment.address,
              caller: operator.account.address,
            }),
          );
          if (result.value !== initialValue) {
            throw new Error(
              `Counter verification failed: expected ${initialValue}, received ${result.value}.`,
            );
          }
        });
        return config;
      } finally {
        for (const attempt of scenario.run.report().attempts) {
          console.log(
            `${attempt.step} (${attempt.outcome}): ${attempt.transactionHash ?? "no hash recorded"}`,
          );
        }
      }
    },
  );
  // Finish report persistence and scenario cleanup before publishing the app environment.
  await writeEnvironment(output, options.rpcUrl, config, operator.seed);
  console.log(
    `Counter ready at ${config.counterAddress}\nSigner: ${operator.address}\nEnvironment: ${output}`,
  );
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
      { flag: "wx", mode: 0o600, flush: true },
    );
    // Publish only after verification, keeping the previous environment on setup failure.
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
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
