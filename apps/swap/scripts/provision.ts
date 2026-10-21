import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bytesEqual,
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  defineCluster,
  fixedBytes,
  hashContract,
  hashFromBase58,
  HttpTransport,
  PrivateKeySigner,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import { prepareContractDeployment } from "@thruputchain/client/wallet";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  ContractType,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  type Contract,
  type ContractAddress,
  type Invocation,
} from "@thruputchain/protocol";

import { SwapFactory } from "../src/contracts/generated/swap-factory";
import { SwapRouter } from "../src/contracts/generated/swap-router";
import { parseExplorerUrl } from "../src/lib/explorer-url";

const GAS_LIMIT = gasAmount(10_000_000n);
const CONTRACT_FUNDING = 10_000_000n;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function provisionSwap(options: {
  network: "local" | "devnet";
  rpcUrl: string;
  networkId: string;
  output: string;
  artifactRoot?: string | undefined;
  publicDirectory?: string | undefined;
  explorerUrl?: string | undefined;
}): Promise<void> {
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
  const expectedNetwork = networkHash(hashFromBase58(options.networkId));
  const explorerUrl = parseExplorerUrl(options.explorerUrl);
  const client = await createThruputClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl,
      networkHash: expectedNetwork,
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
  const [erc20, factoryContract, routerContract, handler, driver] =
    await Promise.all(
      [
        "erc20",
        "swap_factory",
        "swap_router",
        "swap_handler",
        "swap_driver",
      ].map(async (name): Promise<Contract> => ({
        contract_type: ContractType.kRv32,
        rv32_contract: {
          data: await readFile(join(artifactRoot, `${name}.rv32a`)),
        },
      })),
    );
  const tokenHash = hashContract(erc20!);
  const artifactPath = join(artifactDirectory, `${toBase58(tokenHash)}.json`);
  if (erc20?.contract_type !== ContractType.kRv32)
    throw new Error("Expected an RV32 token artifact");
  const artifactContents = `${JSON.stringify({ contractType: "rv32", data: toHex0x(erc20.rv32_contract.data), hash: toBase58(tokenHash) })}\n`;
  const handlerHash = hashContract(handler!);
  const driverHash = hashContract(driver!);

  // This key exists only for this tool invocation. It is never written or logged.
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  const deploy = async (
    name: string,
    contract: Contract,
  ): Promise<ContractAddress> => {
    const deployment = prepareContractDeployment({
      deployer: account.address,
      contract,
    });
    await execute(
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
        receiver: deployment.address,
        amount: CONTRACT_FUNDING,
      }),
    );
    const result = await wallet.deployContractAndWait(
      deployment,
      { gasLimit: GAS_LIMIT, amount: 0n },
      {
        timeoutMs: 60_000,
      },
    );
    console.log(`Deploy ${name}: ${toBase58(result.transactionHash)}`);
    console.log(`${name}: ${toBase58(result.address)}`);
    return result.address;
  };
  const execute = async (invocation: Invocation): Promise<void> => {
    const { transactionHash: txHash } = await wallet.executeAndWait(
      { invocation, gasLimit: GAS_LIMIT },
      { timeoutMs: 60_000 },
    );
    console.log(`Setup transaction: ${toBase58(txHash)}`);
  };

  await mkdir(dirname(environmentPath), { recursive: true });
  await mkdir(dirname(artifactPath), { recursive: true });
  const temporary = `${environmentPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const temporaryArtifact = `${artifactPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    // Check output writability before any ledger writes; preserve the old file on failure.
    await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
    await writeFile(temporaryArtifact, artifactContents, {
      mode: 0o644,
      flag: "wx",
    });
    const airdrop = await wallet.requestAirdrop();
    if ((await wallet.getBalance()).rawBalance < CONTRACT_FUNDING * 6n) {
      throw new Error(
        "Infrastructure deployer airdrop did not provide the required HOG reserve",
      );
    }
    console.log(`Airdrop confirmed: ${airdrop.rawAmount} raw HOG (7 decimals)`);
    // Native-token storage also needs a reserve for future user allowance rows.
    await execute(
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
        receiver: HOG_ADDRESS,
        amount: CONTRACT_FUNDING,
      }),
    );
    // The node persists attached code only when deploy_contract consumes it.
    // These uninitialized instances register infrastructure code, not a pool.
    // ERC20 must instead be attached to the first user-created pair transaction:
    // registering it here would require deploying a forbidden token instance.
    await deploy("Handler", handler!);
    await deploy("Driver", driver!);
    const factory = await deploy("Factory", factoryContract!);
    const router = await deploy("Router", routerContract!);
    await execute(
      SwapFactory.v0_1.initialize.invocation(factory, GAS_LIMIT, {
        hashes: {
          token: fixedBytes(tokenHash, 32),
          handler: fixedBytes(handlerHash, 32),
          driver: fixedBytes(driverHash, 32),
        },
        feeTo: null,
        router,
      }),
    );
    await execute(
      SwapRouter.v0_1.initialize.invocation(router, GAS_LIMIT, { factory }),
    );
    const viewOptions = { client, address: factory, caller: account.address };
    const count = (await SwapFactory.v0_1.allPairsLength.view(viewOptions))
      .value;
    const funding = (await SwapFactory.v0_1.poolFunding.view(viewOptions))
      .value;
    const feeTo = (await SwapFactory.v0_1.feeTo.view(viewOptions)).value;
    if (
      count !== 0n ||
      feeTo !== null ||
      funding.min <= 0n ||
      funding.recommended < funding.min ||
      funding.recommended > ((1n << 128n) - 1n) / 3n
    ) {
      throw new Error(
        "Factory must have no pools, disabled protocol fees, and a valid native funding policy",
      );
    }
    await writeFile(
      temporary,
      renderEnvironment(toBase58(expectedNetwork), rpcUrl, {
        factory,
        router,
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
    console.log(
      `Swap ${options.network} infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toBase58(factory)}\nRouter: ${toBase58(router)}\nLP token code: ${toBase58(tokenHash)}\nHandler code: ${toBase58(handlerHash)}\nDriver code: ${toBase58(driverHash)}`,
    );
    console.warn(
      `No pools or tokens were created. First pair creation can attach the code asset at ${artifactPath}.`,
    );
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryArtifact, { force: true });
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
    `VITE_NATIVE_HOG_ADDRESS=${toBase58(HOG_ADDRESS)}`,
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
