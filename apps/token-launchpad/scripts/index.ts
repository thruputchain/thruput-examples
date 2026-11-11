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
  type ContractDeployment,
} from "@thruputchain/client";
import { prepareContractDeployment } from "@thruputchain/client/wallet";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
  networkHash,
  type ContractAddress,
} from "@thruputchain/protocol";

import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../src/contracts/generated/standard-token-factory";
import { PINNED_NATIVE_BALANCE_ITEM_COST } from "../src/thruput/storage-cost";
import { parseExplorerUrl } from "../src/lib/explorer-url";
import {
  createPersona,
  createRun,
  record,
  saveRun,
  type Client,
  type Run,
  type Persona,
} from "./run";

type FactoryConfig = standard_token_factory_if.v0_1.factory.FactoryConfig;

const GAS_LIMIT = gasAmount(10_000_000n);
const CONTRACT_FUNDING = 10_000_000n;
const TOKEN_INITIALIZATION_BUDGET = 370_000n;
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
  const client = await createThruputClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl,
      ...(options.networkId === undefined
        ? {}
        : {
            networkHash: networkHash(hashFromBase58(options.networkId)),
          }),
      capabilities: ["airdrop"] as const,
    }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 10_000 }),
  });
  const version = await client.getVersionInfo();
  if (!/^14\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version.wireFormat)) {
    throw new Error(
      `Thruput wire format 14.x is required; found ${version.wireFormat}`,
    );
  }
  const [tokenCode, factoryCode] = await Promise.all([
    readFile(join(artifactRoot, "standard_token.rv32a")),
    readFile(join(artifactRoot, "standard_token_factory.rv32a")),
  ]);
  const tokenHash = hashContract({
    contract_type: ContractType.kRv32,
    rv32_contract: { data: tokenCode },
  });
  const artifactPath = join(artifactDirectory, `${toBase58(tokenHash)}.json`);
  const execution = (await client.getChainConfig()).execution;
  if (!execution)
    throw new Error("Node did not report execution storage costs");
  validateTokenFunding(execution.storageCosts, tokenCode.length);
  const artifactContents = `${JSON.stringify({ contractType: "rv32", data: toHex0x(tokenCode), hash: toBase58(tokenHash) })}\n`;

  await mkdir(dirname(environmentPath), { recursive: true });
  await mkdir(dirname(artifactPath), { recursive: true });
  const temporary = `${environmentPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const temporaryArtifact = `${artifactPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const run = await createRun(
    join(dirname(environmentPath), ".local", "launchpad-setup"),
    toBase58(client.network.networkHash),
  );
  console.log(`Run: ${run.directory}`);
  try {
    await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
    await writeFile(temporaryArtifact, artifactContents, {
      mode: 0o644,
      flag: "wx",
    });
    const persona = await createPersona(client, run, "Launchpad Deployer");
    // Unused contractsToDeploy attachments are not persisted by the node.
    // The first user token creation must attach standard_token.rv32a; setup
    // deliberately does not instantiate a token just to register its code.
    const deployment = prepareContractDeployment({
      deployer: persona.account.address,
      contract: factoryCode,
    });
    const factoryAddress = deployment.address;
    run.manifest.factoryAddress = toBase58(factoryAddress);
    await saveRun(run);
    const expectedConfig: FactoryConfig = {
      token_code_hash: fixedBytes(tokenHash, 32),
      required_token_funding: requiredTokenFunding,
      native_token: NATIVE_TOKEN_ADDRESS,
      creation_fee: 0n,
      fee_recipient: null,
    };
    await fundPersona(run, persona);
    await fundNativeReserve(run, persona);
    await deployFactory(run, persona, deployment, expectedConfig);
    await verifyFactory(client, run, deployment, expectedConfig);
    await writeFile(
      temporary,
      renderEnvironment({
        rpcUrl,
        networkHash: run.manifest.networkHash,
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
    );
    // Publish complete code bytes before the environment completion marker.
    await publishArtifact(temporaryArtifact, artifactPath);
    await rename(temporary, environmentPath);
    run.manifest.status = "complete";
    await saveRun(run);
    console.log(
      `Launchpad ${options.network} infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toBase58(factoryAddress)}\nToken code: ${toBase58(tokenHash)}\nRequired token funding: ${requiredTokenFunding}`,
    );
    console.warn(
      `No tokens were created. First token creation can attach the code asset at ${artifactPath}.`,
    );
    return { client, address: factoryAddress };
  } catch (error) {
    run.manifest.status = "failed";
    run.manifest.error = error instanceof Error ? error.message : String(error);
    await saveRun(run);
    throw error;
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryArtifact, { force: true });
  }
}

async function fundPersona(run: Run, persona: Persona) {
  await record(run, `Fund ${persona.name}`, async () => {
    const funding = await persona.wallet.requestAirdrop(wait);
    return { hash: funding.transactionHash, blockHeight: funding.blockHeight };
  });
  if ((await persona.wallet.getBalance()).rawBalance < CONTRACT_FUNDING * 3n)
    throw new Error(
      "Infrastructure deployer airdrop did not provide the required native-token reserve",
    );
}

async function fundNativeReserve(run: Run, persona: Persona) {
  // The native contract needs storage reserve for future token balance rows.
  await record(run, "Fund native-token reserve", () =>
    persona.wallet.executeAndWait(
      {
        invocation: ERC20.v0_1.transfer.invocation(
          NATIVE_TOKEN_ADDRESS,
          GAS_LIMIT,
          {
            receiver: NATIVE_TOKEN_ADDRESS,
            amount: CONTRACT_FUNDING,
          },
        ),
        gasLimit: GAS_LIMIT,
      },
      wait,
    ),
  );
}

async function deployFactory(
  run: Run,
  persona: Persona,
  deployment: ContractDeployment,
  config: FactoryConfig,
) {
  await record(run, "Deploy and initialize token factory", () =>
    persona.wallet.deployContractAndWait(
      deployment,
      {
        gasLimit: GAS_LIMIT,
        amount: CONTRACT_FUNDING,
        initializer: StandardTokenFactory.v0_1.initialize.invocation(
          deployment.address,
          GAS_LIMIT,
          { config },
        ),
      },
      wait,
    ),
  );
}

async function verifyFactory(
  client: Client,
  run: Run,
  deployment: ContractDeployment,
  expected: FactoryConfig,
) {
  const observed = (
    await StandardTokenFactory.v0_1.config.view({
      client,
      address: deployment.address,
      minStateBlockHeight: run.latestBlockHeight,
    })
  ).value;
  // Compare with scenario inputs, independently of the deployment receipt.
  if (
    !bytesEqual(observed.token_code_hash, expected.token_code_hash) ||
    observed.required_token_funding !== expected.required_token_funding ||
    !bytesEqual(observed.native_token, expected.native_token) ||
    observed.creation_fee !== 0n ||
    observed.fee_recipient !== null
  ) {
    throw new Error("The deployed factory configuration could not be verified");
  }
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
