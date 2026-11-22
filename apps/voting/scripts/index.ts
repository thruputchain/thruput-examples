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
} from "@thruputchain/client";
import {
  createKeyFile,
  createOutputDirectory,
  loadArtifacts,
  withScenario,
} from "@thruputchain/testkit";
import { gasAmount, networkHash } from "@thruputchain/protocol";
import { errorMessage } from "../src/config";
import { parseRpcUrl } from "../server/config";
import { Voting } from "../src/contracts/generated/voting";

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
  const artifacts = await loadArtifacts({
    voting: resolve(
      repositoryRoot,
      options.artifact || "target/thruput/voting.rv32a",
    ),
  });
  const cluster = defineCluster({
    name: options.network,
    rpcUrl,
    capabilities: ["airdrop"] as const,
    ...(options.networkId === undefined
      ? {}
      : {
          networkHash: networkHash(hashFromBase58(options.networkId)),
        }),
  });
  const transport = new HttpTransport(rpcUrl, { timeoutMs: 15_000 });
  // Preserve discovery and optional pins. This external client remains usable after setup.
  const client = await createThruputClient({ cluster, transport });
  const expectedNetwork = networkHash(
    hashFromBase58(toBase58(client.network.networkHash)),
  );
  const output = resolve(repositoryRoot, options.output);
  const directory = await createOutputDirectory(
    join(dirname(output), ".local", "voting-setup"),
  );
  const runDirectory = join(directory, "transactions");
  console.log(`Report: ${join(runDirectory, "report.json")}`);
  // Save the private key before funding or deployment, so a failed run can be recovered.
  const deployer = await createKeyFile(join(directory, "key.json"));
  const deployment = artifacts.voting.prepare(deployer.account.address);
  const address = toBase58(deployment.address);
  await withScenario(
    {
      network: {
        cluster: { ...cluster, networkHash: expectedNetwork },
        transport,
      },
      accounts: { "Voting Deployer": deployer.account },
      runDirectory,
    },
    async (scenario) => {
      const actor = scenario.actor("Voting Deployer");
      console.log(
        `Deployer: ${deployer.address}\nPredicted Voting: ${address}`,
      );
      try {
        // The faucet chooses the amount. The report records the request and its hash.
        await scenario.run.step("fund-deployer", () =>
          actor.fund({ timeoutMs: wait.timeoutMs }),
        );
        await scenario.run.step(
          "deploy-voting",
          () =>
            actor.deploy(deployment, {
              // Funding and deployment are atomic. Voting has no initializer.
              gasLimit: deploymentGas,
              amount: storageFunding,
              wait,
            }),
          { metadata: { address } },
        );
        await scenario.run.step("verify-voting", async () => {
          // Testkit reads state containing the confirmed deployment.
          const count = await scenario.view(
            Voting.v0_1.count.viewRequest({ address: deployment.address }),
          );
          // Expected state comes from a fresh deployment, independently of its receipt.
          if (count.value !== 0n) {
            throw new Error(
              `Voting verification failed: expected 0 polls, received ${count.value}.`,
            );
          }
        });
      } finally {
        for (const attempt of scenario.run.report().attempts) {
          console.log(
            `${attempt.step} (${attempt.outcome}): ${attempt.transactionHash ?? "no hash recorded"}`,
          );
        }
      }
    },
  );
  // Finish report persistence and scenario cleanup before replacing app configuration.
  await writeEnvironment(output, rpcUrl, toBase58(expectedNetwork), address);
  console.log(`Voting ready: ${address}\nEnvironment: ${output}`);
  return { client, address: deployment.address };
}

async function writeEnvironment(
  output: string,
  rpcUrl: string,
  networkId: string,
  address: string,
) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporary,
      [
        `THRUPUT_RPC_URL=${rpcUrl}`,
        `VITE_THRUPUT_NETWORK_ID=${networkId}`,
        `VITE_VOTING_ADDRESS=${address}`,
        "PORT=3000",
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600, flush: true },
    );
    // Publish only after verification. Setup failure keeps the previous environment.
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
