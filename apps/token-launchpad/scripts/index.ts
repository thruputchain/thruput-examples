import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  bytesEqual,
  createThruputClient,
  defineCluster,
  fixedBytes,
  hashContract,
  hashFromBase58,
  HttpTransport,
  toBase58,
  toHex0x,
  type RpcStorageCosts,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
  networkHash,
  type ContractAddress,
} from "@thruputchain/protocol";
import {
  createKeyFile,
  createOutputDirectory,
  loadArtifacts,
  withScenario,
} from "@thruputchain/testkit";

import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../src/contracts/generated/standard-token-factory";
import { PINNED_NATIVE_BALANCE_ITEM_COST } from "../src/thruput/storage-cost";
import { parseExplorerUrl } from "../src/lib/explorer-url";

type FactoryConfig = standard_token_factory_if.v0_1.factory.FactoryConfig;

const GAS_LIMIT = gasAmount(10_000_000n);
const CONTRACT_FUNDING = 10_000_000n;
// Covers a standard-token artifact of up to about 36.9 KB at the local runtime's
// costs. The SDK 0.64.0 build is about 34.2 KB.
const TOKEN_INITIALIZATION_BUDGET = 420_000n;
// Leave storage reserve for allowance and recipient rows after initialization.
const REQUIRED_TOKEN_FUNDING = 1_000_000n;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const wait = { timeoutMs: 60_000 };
const networks = {
  local: {
    rpcUrl: "http://127.0.0.1:9545",
    output: "../.env.local",
    explorerUrl: "",
  },
  devnet: {
    rpcUrl: "https://rpc.thruput.network",
    output: "../.env.devnet",
    explorerUrl: "https://explorer.thruput.network",
  },
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
  if (env.THRUPUT_RUNTIME_MANIFEST) {
    const manifest: { networkHash?: string } = JSON.parse(
      await readFile(
        resolve(repositoryRoot, env.THRUPUT_RUNTIME_MANIFEST),
        "utf8",
      ),
    );
    const recorded = toBase58(hashFromBase58(manifest.networkHash ?? ""));
    if (networkId !== undefined && networkId !== recorded)
      throw new Error("Runtime manifest and THRUPUT_NETWORK_ID disagree.");
    networkId = recorded;
  }
  return provisionLaunchpad({
    network,
    rpcUrl: env.THRUPUT_RPC_URL ?? defaults.rpcUrl,
    networkId,
    output:
      env.LAUNCHPAD_APP_ENV ||
      fileURLToPath(new URL(defaults.output, import.meta.url)),
    artifactRoot: env.LAUNCHPAD_ARTIFACT_ROOT,
    publicDirectory: env.LAUNCHPAD_APP_PUBLIC_DIR,
    explorerUrl: env.VITE_EXPLORER_URL ?? defaults.explorerUrl,
  });
}

export async function provisionLaunchpad(options: {
  network: "local" | "devnet";
  rpcUrl: string;
  networkId?: string | undefined;
  output: string;
  artifactRoot?: string | undefined;
  publicDirectory?: string | undefined;
  explorerUrl?: string | undefined;
}) {
  const artifactRoot = resolve(
    repositoryRoot,
    options.artifactRoot || "target/thruput",
  );
  const environmentPath = resolve(repositoryRoot, options.output);
  const artifactDirectory = join(
    resolve(
      repositoryRoot,
      options.publicDirectory ||
        fileURLToPath(new URL("../public", import.meta.url)),
    ),
    "contract-artifacts",
  );
  const rpcUrl = options.rpcUrl;
  const explorerUrl = parseExplorerUrl(options.explorerUrl);
  const requiredTokenFunding =
    options.network === "devnet" ? CONTRACT_FUNDING : REQUIRED_TOKEN_FUNDING;
  const cluster = defineCluster({
    name: options.network,
    rpcUrl,
    ...(options.networkId === undefined
      ? {}
      : { networkHash: networkHash(hashFromBase58(options.networkId)) }),
    capabilities: ["airdrop"] as const,
  });
  const transport = new HttpTransport(rpcUrl, { timeoutMs: 10_000 });
  // Preserve discovery and optional pins. This external client remains usable after setup.
  const client = await createThruputClient({ cluster, transport });
  // Pin the scenario to the network the SDK discovered and checked.
  const expectedNetwork = networkHash(
    hashFromBase58(toBase58(client.network.networkHash)),
  );
  const version = await client.getVersionInfo();
  if (!/^14\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version.wireFormat)) {
    throw new Error(
      `Thruput wire format 14.x is required; found ${version.wireFormat}`,
    );
  }
  // Setup never deploys the token. It needs its raw bytes for the code hash
  // and the published artifact.
  const tokenCode = await readFile(join(artifactRoot, "standard_token.rv32a"));
  const { factory } = await loadArtifacts({
    factory: join(artifactRoot, "standard_token_factory.rv32a"),
  });
  const tokenHash = hashContract({
    contract_type: ContractType.kRv32,
    rv32_contract: { data: tokenCode },
  });
  const artifactPath = join(artifactDirectory, `${toBase58(tokenHash)}.json`);
  const execution = (await client.getChainConfig()).execution;
  if (!execution)
    throw new Error("Node did not report execution storage costs");
  validateTokenFunding(execution.storageCosts, tokenCode.length);

  const directory = await createOutputDirectory(
    join(dirname(environmentPath), ".local", "launchpad-setup"),
  );
  const runDirectory = join(directory, "transactions");
  console.log(`Report: ${join(runDirectory, "report.json")}`);
  // Save the private key before funding or deployment, so a failed run can be recovered.
  const deployer = await createKeyFile(join(directory, "key.json"));
  // Unused contractsToDeploy attachments are not persisted by the node.
  // The first user token creation must attach standard_token.rv32a; setup
  // deliberately does not instantiate a token just to register its code.
  const deployment = factory.prepare(deployer.account.address);
  const factoryAddress = deployment.address;
  const expected: FactoryConfig = {
    token_code_hash: fixedBytes(tokenHash, 32),
    required_token_funding: requiredTokenFunding,
    native_token: NATIVE_TOKEN_ADDRESS,
    creation_fee: 0n,
    fee_recipient: null,
  };
  await withScenario(
    {
      network: {
        cluster: { ...cluster, networkHash: expectedNetwork },
        transport,
      },
      accounts: { "Launchpad Deployer": deployer.account },
      runDirectory,
    },
    async (scenario) => {
      const actor = scenario.actor("Launchpad Deployer");
      console.log(
        `Deployer: ${deployer.address}\nPredicted factory: ${toBase58(factoryAddress)}`,
      );
      try {
        await scenario.run.step("fund-deployer", async () => {
          // The faucet chooses the amount. The report records the request and its hash.
          await actor.fund({ timeoutMs: wait.timeoutMs });
          const { rawBalance } = await actor.wallet.getBalance();
          if (rawBalance < CONTRACT_FUNDING * 3n)
            throw new Error(
              "Infrastructure deployer airdrop did not provide the required native-token reserve",
            );
        });
        // The native contract needs storage reserve for future token balance rows.
        await scenario.run.step("fund-native-reserve", () =>
          actor.call(
            [
              ERC20.v0_1.transfer.call({
                address: NATIVE_TOKEN_ADDRESS,
                gasLimit: GAS_LIMIT,
                args: {
                  receiver: NATIVE_TOKEN_ADDRESS,
                  amount: CONTRACT_FUNDING,
                },
              }),
            ],
            { wait },
          ),
        );
        await scenario.run.step(
          "deploy-factory",
          () =>
            // Funding, deployment, and initialization succeed or fail together.
            actor.deploy(deployment, {
              gasLimit: GAS_LIMIT,
              amount: CONTRACT_FUNDING,
              initializer: StandardTokenFactory.v0_1.initialize.call({
                address: factoryAddress,
                gasLimit: GAS_LIMIT,
                args: { config: expected },
              }),
              wait,
            }),
          { metadata: { address: toBase58(factoryAddress) } },
        );
        await scenario.run.step("verify-factory", async () => {
          // Testkit reads state containing the confirmed deployment.
          const observed = (
            await scenario.view(
              StandardTokenFactory.v0_1.config.viewRequest({
                address: factoryAddress,
              }),
            )
          ).value;
          // Compare with scenario inputs, independently of the deployment receipt.
          if (
            !bytesEqual(observed.token_code_hash, expected.token_code_hash) ||
            observed.required_token_funding !==
              expected.required_token_funding ||
            !bytesEqual(observed.native_token, expected.native_token) ||
            observed.creation_fee !== 0n ||
            observed.fee_recipient !== null
          )
            throw new Error(
              "The deployed factory configuration could not be verified",
            );
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

  // Finish report persistence and scenario cleanup before publishing app files.
  await mkdir(dirname(environmentPath), { recursive: true });
  await mkdir(dirname(artifactPath), { recursive: true });
  const temporary = `${environmentPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const temporaryArtifact = `${artifactPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporaryArtifact,
      `${JSON.stringify({ contractType: "rv32", data: toHex0x(tokenCode), hash: toBase58(tokenHash) })}\n`,
      { mode: 0o644, flag: "wx" },
    );
    await writeFile(
      temporary,
      renderEnvironment({
        rpcUrl,
        networkHash: toBase58(expectedNetwork),
        factoryAddress,
        tokenHash,
      }) +
        (options.network === "devnet"
          ? [
              `VITE_EXPLORER_URL=${explorerUrl ?? ""}`,
              "VITE_SWAP_APP_URL=",
              "PORT=3000",
              "",
            ].join("\n")
          : ""),
      { mode: 0o600, flag: "wx", flush: true },
    );
    // Publish complete code bytes before the environment completion marker.
    await publishArtifact(temporaryArtifact, artifactPath);
    await rename(temporary, environmentPath);
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryArtifact, { force: true });
  }
  console.log(
    `Launchpad ${options.network} infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toBase58(factoryAddress)}\nToken code: ${toBase58(tokenHash)}\nRequired token funding: ${requiredTokenFunding}`,
  );
  console.warn(
    `No tokens were created. First token creation can attach the code asset at ${artifactPath}.`,
  );
  return { client, address: factoryAddress };
}

function renderEnvironment(input: {
  rpcUrl: string;
  networkHash: string;
  factoryAddress: ContractAddress;
  tokenHash: Uint8Array;
}): string {
  return [
    `VITE_THRUPUT_RPC_URL=${input.rpcUrl}`,
    `VITE_THRUPUT_NETWORK_ID=${input.networkHash}`,
    `VITE_NATIVE_TOKEN_ADDRESS=${toBase58(NATIVE_TOKEN_ADDRESS)}`,
    `VITE_NATIVE_BALANCE_ITEM_COST=${PINNED_NATIVE_BALANCE_ITEM_COST}`,
    `VITE_STANDARD_TOKEN_FACTORY_ADDRESS=${toBase58(input.factoryAddress)}`,
    `VITE_STANDARD_TOKEN_HASH=${toBase58(input.tokenHash)}`,
    "",
  ].join("\n");
}

export function validateTokenFunding(
  costs: RpcStorageCosts,
  artifactBytes: number,
): void {
  // The browser's prefunding calculation requires this balance bookkeeping cost.
  if (costs.balanceCost !== PINNED_NATIVE_BALANCE_ITEM_COST)
    throw new Error(
      "Unsupported native balanceCost for the app's pinned runtime",
    );
  // initialize_once writes Config and at most holder + total_supply NNInt rows.
  // Config's conservative XDR bound is 168 bytes: address 32, optional name
  // (100 bytes) 108, optional symbol (10 bytes padded to 12) 20, decimals 8.
  // Include native balance bookkeeping as well. No token auth/RCQ/replay rows
  // are created: the factory invokes the initializer as a nested call.
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 0)
    throw new Error("Invalid token artifact size");
  const maximumCost =
    costs.baseContractDeploymentCost +
    BigInt(artifactBytes) * costs.contractDeploymentCostPerByte +
    3n * costs.baseDataItemCost +
    168n * costs.bytestringCostPerByte +
    costs.balanceCost;
  if (maximumCost > TOKEN_INITIALIZATION_BUDGET) {
    throw new Error(
      `Token artifact exceeds the ${TOKEN_INITIALIZATION_BUDGET} deployment/initialization funding budget`,
    );
  }
}

export async function publishArtifact(
  temporary: string,
  destination: string,
): Promise<void> {
  try {
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!bytesEqual(await readFile(temporary), await readFile(destination))) {
      throw new Error("Existing hash-named artifact has different contents");
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: { network: { type: "string", default: "local" } },
  });
  if (values.network !== "local" && values.network !== "devnet")
    throw new Error("Use --network local or --network devnet.");
  await setup(process.env, values.network);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
