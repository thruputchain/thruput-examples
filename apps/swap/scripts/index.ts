import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serializeCxs, Uint32Codec, VarOpaqueCodec } from "@thruputchain/xdr";

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
  type Scenario,
} from "@thruputchain/testkit";

import {
  SwapFactory,
  type swap_if,
} from "../src/contracts/generated/swap-factory";
import { SwapRouter } from "../src/contracts/generated/swap-router";
import { parseExplorerUrl } from "../src/lib/explorer-url";

const GAS_LIMIT = gasAmount(10_000_000n);
const CONTRACT_FUNDING = 10_000_000n;
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
type SwapHashes = swap_if.v0_1.factory.SwapHashes;

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
  return provisionSwap({
    network,
    rpcUrl: env.THRUPUT_RPC_URL ?? defaults.rpcUrl,
    networkId,
    output:
      env.SWAP_APP_ENV ||
      fileURLToPath(new URL(defaults.output, import.meta.url)),
    artifactRoot: env.SWAP_ARTIFACT_ROOT,
    publicDirectory: env.SWAP_APP_PUBLIC_DIR,
    explorerUrl: env.VITE_EXPLORER_URL ?? defaults.explorerUrl,
  });
}

export async function provisionSwap(options: {
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
  const artifacts = await loadArtifacts({
    handler: join(artifactRoot, "swap_handler.rv32a"),
    driver: join(artifactRoot, "swap_driver.rv32a"),
    factory: join(artifactRoot, "swap_factory.rv32a"),
    router: join(artifactRoot, "swap_router.rv32a"),
  });
  // Setup never deploys this ERC20 code. It needs the raw bytes for the code
  // hash and the published artifact.
  const erc20 = await readFile(join(artifactRoot, "erc20.rv32a"));
  const codeHash = (data: Uint8Array) =>
    fixedBytes(
      hashContract({
        contract_type: ContractType.kRv32,
        rv32_contract: { data },
      }),
      32,
    );

  const directory = await createOutputDirectory(
    join(dirname(environmentPath), ".local", "swap-setup"),
  );
  const runDirectory = join(directory, "transactions");
  console.log(`Report: ${join(runDirectory, "report.json")}`);
  // Save the private key before funding or deployment, so a failed run can be recovered.
  const deployer = await createKeyFile(join(directory, "key.json"));
  // Predict every address first: each initializer stores another contract's address.
  const handler = artifacts.handler.prepare(deployer.account.address);
  const driver = artifacts.driver.prepare(deployer.account.address);
  const factory = artifacts.factory.prepare(deployer.account.address);
  const router = artifacts.router.prepare(deployer.account.address);
  const hashes: SwapHashes = {
    token: codeHash(erc20),
    handler: fixedBytes(handler.contractHash, 32),
    driver: fixedBytes(driver.contractHash, 32),
  };
  const tokenHash = hashes.token;
  const artifactPath = join(artifactDirectory, `${toBase58(tokenHash)}.json`);

  // Check both outputs before any transaction spends funds.
  await mkdir(dirname(environmentPath), { recursive: true });
  await mkdir(dirname(artifactPath), { recursive: true });
  const temporary = `${environmentPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const temporaryArtifact = `${artifactPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporaryArtifact,
      `${JSON.stringify({ contractType: "rv32", data: toHex0x(erc20), hash: toBase58(tokenHash) })}\n`,
      { mode: 0o644, flag: "wx" },
    );
    await writeFile(temporary, "", { mode: 0o600, flag: "wx" });

    await withScenario(
      {
        network: {
          cluster: { ...cluster, networkHash: expectedNetwork },
          transport,
        },
        accounts: { "Swap Deployer": deployer.account },
        runDirectory,
      },
      async (scenario) => {
        const actor = scenario.actor("Swap Deployer");
        console.log(
          `Deployer: ${deployer.address}\nPredicted factory: ${toBase58(factory.address)}\nPredicted router: ${toBase58(router.address)}`,
        );
        try {
          await scenario.run.step("fund-deployer", async () => {
            // The faucet chooses the amount. The report records the request and its hash.
            await actor.fund({ timeoutMs: wait.timeoutMs });
            // Five storage deposits plus one token of remaining scheduling capacity.
            const { rawBalance } = await actor.wallet.getBalance();
            if (rawBalance < CONTRACT_FUNDING * 6n)
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
          // Unused attachments are not persisted. Deploy uninitialized handler and
          // driver instances to register their code. The first pair creation attaches LP code.
          for (const [name, deployment] of [
            ["handler", handler],
            ["driver", driver],
          ] as const)
            await scenario.run.step(
              `register-${name}`,
              () =>
                actor.deploy(deployment, {
                  gasLimit: GAS_LIMIT,
                  amount: CONTRACT_FUNDING,
                  wait,
                }),
              { metadata: { address: toBase58(deployment.address) } },
            );
          await scenario.run.step(
            "deploy-factory",
            () =>
              // Funding, deployment, and initialization succeed or fail together.
              actor.deploy(factory, {
                gasLimit: GAS_LIMIT,
                amount: CONTRACT_FUNDING,
                initializer: SwapFactory.v0_1.initialize.call({
                  address: factory.address,
                  gasLimit: GAS_LIMIT,
                  args: { hashes, feeTo: null, router: router.address },
                }),
                wait,
              }),
            { metadata: { address: toBase58(factory.address) } },
          );
          await scenario.run.step(
            "deploy-router",
            () =>
              actor.deploy(router, {
                gasLimit: GAS_LIMIT,
                amount: CONTRACT_FUNDING,
                initializer: SwapRouter.v0_1.initialize.call({
                  address: router.address,
                  gasLimit: GAS_LIMIT,
                  args: { factory: factory.address },
                }),
                wait,
              }),
            { metadata: { address: toBase58(router.address) } },
          );
          await scenario.run.step("verify-swap", () =>
            verifySwap(scenario, factory.address, router.address, hashes),
          );
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
    await writeFile(
      temporary,
      renderEnvironment(toBase58(expectedNetwork), rpcUrl, {
        factory: factory.address,
        router: router.address,
        tokenHash,
      }) +
        (options.network === "devnet"
          ? [`VITE_EXPLORER_URL=${explorerUrl ?? ""}`, "PORT=3000", ""].join(
              "\n",
            )
          : ""),
      { mode: 0o600, flush: true },
    );
    // Publish complete code bytes before the environment completion marker.
    await publishArtifact(temporaryArtifact, artifactPath);
    await rename(temporary, environmentPath);
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryArtifact, { force: true });
  }
  console.log(
    `Swap ${options.network} infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toBase58(factory.address)}\nRouter: ${toBase58(router.address)}\nLP token code: ${toBase58(tokenHash)}`,
  );
  console.log(
    `No pools or tokens were created. First pair creation can attach the code asset at ${artifactPath}.`,
  );
  return { client, factory: factory.address, router: router.address };
}

async function verifySwap(
  scenario: Pick<Scenario, "view" | "confirmedHeight"> & {
    client: Pick<Scenario["client"], "getStorage">;
  },
  factory: ContractAddress,
  router: ContractAddress,
  hashes: SwapHashes,
) {
  // Testkit reads state containing every confirmed setup transaction.
  const [count, funding, feeTo] = await Promise.all([
    scenario.view(
      SwapFactory.v0_1.allPairsLength.viewRequest({ address: factory }),
    ),
    scenario.view(
      SwapFactory.v0_1.poolFunding.viewRequest({ address: factory }),
    ),
    scenario.view(SwapFactory.v0_1.feeTo.viewRequest({ address: factory })),
  ]);
  // Independent expectations from the scenario and factory's POOL_FUNDING policy.
  if (
    count.value !== 0n ||
    feeTo.value !== null ||
    funding.value.min !== 128_000n ||
    funding.value.recommended !== 10_000_000n
  )
    throw new Error(
      "Factory must have no pools, disabled protocol fees, and the expected native funding policy",
    );

  // No ABI getters expose these fields. Follow the pinned #[storage] layouts:
  // Factory.hashes (0), Factory.router (2), Router.cfg (0). CXS addresses and
  // hashes are fixed 32-byte values; SwapHashes stores token, handler, driver.
  for (const [address, domain, slot, expected] of [
    [
      factory,
      "Factory",
      0,
      Buffer.concat([hashes.token, hashes.handler, hashes.driver]),
    ],
    [factory, "Factory", 2, router],
    [router, "Router", 0, factory],
  ] as const) {
    const frame = (bytes: Uint8Array) =>
      Buffer.concat([serializeCxs(BigInt(bytes.length), Uint32Codec), bytes]);
    const key = createHash("sha256")
      .update(frame(serializeCxs(Buffer.from(domain), VarOpaqueCodec(100))))
      .update(frame(serializeCxs(BigInt(slot), Uint32Codec)))
      .digest();
    const { item, stateBlockHeight } = await scenario.client.getStorage({
      address,
      key,
    });
    // getStorage has no minimum-height input in this SDK; reject a stale result.
    if (stateBlockHeight < scenario.confirmedHeight)
      throw new Error("Swap verification received stale storage state");
    if (
      !item ||
      !("kind" in item) ||
      item.kind !== "bytestring" ||
      !bytesEqual(item.bytes, expected)
    )
      throw new Error(
        "Swap code hashes or factory/router relationship could not be verified",
      );
  }
}

function renderEnvironment(
  network: string,
  rpcUrl: string,
  deployment: {
    factory: ContractAddress;
    router: ContractAddress;
    tokenHash: Uint8Array;
  },
): string {
  return [
    `VITE_THRUPUT_RPC_URL=${rpcUrl}`,
    `VITE_THRUPUT_NETWORK_ID=${network}`,
    `VITE_NATIVE_TOKEN_ADDRESS=${toBase58(NATIVE_TOKEN_ADDRESS)}`,
    `VITE_SWAP_FACTORY_ADDRESS=${toBase58(deployment.factory)}`,
    `VITE_SWAP_ROUTER_ADDRESS=${toBase58(deployment.router)}`,
    `VITE_POOL_TOKEN_HASH=${toBase58(deployment.tokenHash)}`,
    "",
  ].join("\n");
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
