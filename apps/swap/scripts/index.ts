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
  SwapFactory,
  type swap_if,
} from "../src/contracts/generated/swap-factory";
import { SwapRouter } from "../src/contracts/generated/swap-router";
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
  const client = await createThruputClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl,
      ...(options.networkId === undefined
        ? {}
        : { networkHash: networkHash(hashFromBase58(options.networkId)) }),
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
  const [erc20, factoryCode, routerCode, handlerCode, driverCode] =
    await Promise.all([
      readFile(join(artifactRoot, "erc20.rv32a")),
      readFile(join(artifactRoot, "swap_factory.rv32a")),
      readFile(join(artifactRoot, "swap_router.rv32a")),
      readFile(join(artifactRoot, "swap_handler.rv32a")),
      readFile(join(artifactRoot, "swap_driver.rv32a")),
    ]);
  const codeHash = (data: Uint8Array) =>
    fixedBytes(
      hashContract({
        contract_type: ContractType.kRv32,
        rv32_contract: { data },
      }),
      32,
    );
  const hashes: SwapHashes = {
    token: codeHash(erc20),
    handler: codeHash(handlerCode),
    driver: codeHash(driverCode),
  };
  const tokenHash = hashes.token;
  const artifactPath = join(artifactDirectory, `${toBase58(tokenHash)}.json`);
  const artifactContents = `${JSON.stringify({ contractType: "rv32", data: toHex0x(erc20), hash: toBase58(tokenHash) })}\n`;

  await mkdir(dirname(environmentPath), { recursive: true });
  await mkdir(dirname(artifactPath), { recursive: true });
  const temporary = `${environmentPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const temporaryArtifact = `${artifactPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const run = await createRun(
    join(dirname(environmentPath), ".local", "swap-setup"),
    toBase58(client.network.networkHash),
  );
  console.log(`Run: ${run.directory}`);
  try {
    // Check output writability before any ledger writes; preserve the old file on failure.
    await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
    await writeFile(temporaryArtifact, artifactContents, {
      mode: 0o644,
      flag: "wx",
    });
    const persona = await createPersona(client, run, "Swap Deployer");
    // Predict both addresses first: each initializer stores the other's address.
    const handler = prepareContractDeployment({
      deployer: persona.account.address,
      contract: handlerCode,
    });
    const driver = prepareContractDeployment({
      deployer: persona.account.address,
      contract: driverCode,
    });
    const factory = prepareContractDeployment({
      deployer: persona.account.address,
      contract: factoryCode,
    });
    const router = prepareContractDeployment({
      deployer: persona.account.address,
      contract: routerCode,
    });
    run.manifest.addresses = {
      handler: toBase58(handler.address),
      driver: toBase58(driver.address),
      factory: toBase58(factory.address),
      router: toBase58(router.address),
    };
    await saveRun(run);

    await fundPersona(run, persona);
    await fundNativeReserve(run, persona);
    await registerCode(run, persona, "Handler", handler);
    await registerCode(run, persona, "Driver", driver);
    await deployFactory(run, persona, factory, router.address, hashes);
    await deployRouter(run, persona, router, factory.address);
    await verifySwap(client, run, factory.address, router.address, hashes);
    await writeFile(
      temporary,
      renderEnvironment(run.manifest.networkHash, rpcUrl, {
        factory: factory.address,
        router: router.address,
        tokenHash,
      }) +
        (options.network === "devnet"
          ? [
              `VITE_EXPLORER_URL=${explorerUrl ?? ""}`,
              "VITE_TOKEN_DISCOVERY_ENABLED=false",
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
      `Swap ${options.network} infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toBase58(factory.address)}\nRouter: ${toBase58(router.address)}\nLP token code: ${toBase58(tokenHash)}`,
    );
    console.log(
      `No pools or tokens were created. First pair creation can attach the code asset at ${artifactPath}.`,
    );
    return { client, factory: factory.address, router: router.address };
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
  // Five storage deposits plus one token of remaining scheduling capacity.
  if ((await persona.wallet.getBalance()).rawBalance < CONTRACT_FUNDING * 6n)
    throw new Error(
      "Infrastructure deployer airdrop did not provide the required native-token reserve",
    );
}

async function fundNativeReserve(run: Run, persona: Persona) {
  await record(run, "Fund native-token reserve", () =>
    persona.wallet.executeAndWait(
      {
        invocation: ERC20.v0_1.transfer.invocation(
          NATIVE_TOKEN_ADDRESS,
          GAS_LIMIT,
          { receiver: NATIVE_TOKEN_ADDRESS, amount: CONTRACT_FUNDING },
        ),
        gasLimit: GAS_LIMIT,
      },
      wait,
    ),
  );
}

async function registerCode(
  run: Run,
  persona: Persona,
  name: string,
  deployment: ContractDeployment,
) {
  // Unused attachments are not persisted. Deploy uninitialized handler/driver
  // instances to register their code. The first pair creation attaches LP code.
  await record(run, `Register ${name} code`, () =>
    persona.wallet.deployContractAndWait(
      deployment,
      { gasLimit: GAS_LIMIT, amount: CONTRACT_FUNDING },
      wait,
    ),
  );
}

async function deployFactory(
  run: Run,
  persona: Persona,
  deployment: ContractDeployment,
  router: ContractAddress,
  hashes: SwapHashes,
) {
  await record(run, "Deploy and initialize Swap factory", () =>
    persona.wallet.deployContractAndWait(
      deployment,
      {
        gasLimit: GAS_LIMIT,
        amount: CONTRACT_FUNDING,
        initializer: SwapFactory.v0_1.initialize.invocation(
          deployment.address,
          GAS_LIMIT,
          { hashes, feeTo: null, router },
        ),
      },
      wait,
    ),
  );
}

async function deployRouter(
  run: Run,
  persona: Persona,
  deployment: ContractDeployment,
  factory: ContractAddress,
) {
  await record(run, "Deploy and initialize Swap router", () =>
    persona.wallet.deployContractAndWait(
      deployment,
      {
        gasLimit: GAS_LIMIT,
        amount: CONTRACT_FUNDING,
        initializer: SwapRouter.v0_1.initialize.invocation(
          deployment.address,
          GAS_LIMIT,
          { factory },
        ),
      },
      wait,
    ),
  );
}

async function verifySwap(
  client: Client,
  run: Run,
  factory: ContractAddress,
  router: ContractAddress,
  hashes: SwapHashes,
) {
  const view = {
    client,
    address: factory,
    minStateBlockHeight: run.latestBlockHeight,
  };
  const count = (await SwapFactory.v0_1.allPairsLength.view(view)).value;
  const funding = (await SwapFactory.v0_1.poolFunding.view(view)).value;
  const feeTo = (await SwapFactory.v0_1.feeTo.view(view)).value;
  // Independent expectations from the scenario and factory's POOL_FUNDING policy.
  if (
    count !== 0n ||
    feeTo !== null ||
    funding.min !== 128_000n ||
    funding.recommended !== 10_000_000n
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
    const { item, stateBlockHeight } = await client.getStorage({
      address,
      key,
    });
    // getStorage has no minimum-height input in this SDK; reject a stale result.
    if (stateBlockHeight < run.latestBlockHeight)
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
