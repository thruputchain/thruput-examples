import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  fixedBytes,
  fromHex0x,
  hashContract,
  HttpTransport,
  localnet,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { deriveContractAddress } from "@groundhogchain/client/contract";
import { DefaultWallet, ERC20 } from "@groundhogchain/client/contracts";
import {
  ContractType,
  ExecResult,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  sha256Hash,
  type Contract,
  type ContractAddress,
  type Invocation,
} from "@groundhogchain/protocol";

import { SwapFactory } from "../src/contracts/generated/swap-factory";
import { SwapRouter } from "../src/contracts/generated/swap-router";

const GAS_LIMIT = gasAmount(10_000_000n);
const CONTRACT_FUNDING = 10_000_000n;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function main(): Promise<void> {
  const artifactRoot = resolve(
    repositoryRoot,
    process.env.SWAP_ARTIFACT_ROOT || "target/groundhog",
  );
  const environmentPath = resolve(
    repositoryRoot,
    process.env.SWAP_APP_ENV || "apps/swap/.env.local",
  );
  const artifactDirectory = join(
    resolve(
      repositoryRoot,
      process.env.SWAP_APP_PUBLIC_DIR ||
        fileURLToPath(new URL("../public", import.meta.url)),
    ),
    "contract-artifacts",
  );
  const rpcUrl = validateLocalRpcUrl(
    process.env.GROUNDHOG_RPC_URL || "http://127.0.0.1:9545",
  );
  const expectedNetwork = await readNetworkHash();
  const client = await createGroundhogClient({
    cluster: localnet({ rpcUrl, networkHash: expectedNetwork }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 10_000 }),
  });
  const version = await client.getVersion();
  if (
    !/^(?:[4-9]|[1-9]\d+)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
      version.wireFormat,
    )
  ) {
    throw new Error(
      `Groundhog wire format >=4.0.0 is required; found ${version.wireFormat}`,
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
  const artifactPath = join(artifactDirectory, `${toHex0x(tokenHash)}.json`);
  if (erc20?.contract_type !== ContractType.kRv32)
    throw new Error("Expected an RV32 token artifact");
  const artifactContents = `${JSON.stringify({ contractType: "rv32", data: toHex0x(erc20.rv32_contract.data), hash: toHex0x(tokenHash) })}\n`;
  const handlerHash = hashContract(handler!);
  const driverHash = hashContract(driver!);

  // This key exists only for this tool invocation. It is never written or logged.
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  const requireSuccess = (result: ExecResult): void => {
    if (result !== ExecResult.ExecResultOK) {
      throw new Error(`Setup transaction failed with ${ExecResult[result]}`);
    }
  };
  const deploy = async (contract: Contract): Promise<ContractAddress> => {
    const nonce = sha256Hash(randomBytes(32));
    const contractHash = hashContract(contract);
    const predicted = deriveContractAddress(
      account.address,
      nonce,
      contractHash,
    );
    await execute(
      ERC20.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
        receiver: predicted,
        amount: CONTRACT_FUNDING,
      }),
    );
    const hash = await wallet.sendInvocation({
      invocation: DefaultWallet.deploy.invocation(account.address, GAS_LIMIT, {
        nonce: fixedBytes(nonce, 32),
        contractHash: fixedBytes(contractHash, 32),
      }),
      contractsToDeploy: [contract],
    });
    const receipt = await wallet.waitForTransactionReceipt(hash);
    requireSuccess(receipt.execResult);
    const deployed = DefaultWallet.deploy.decodeReceipt(receipt).value;
    if (!bytesEqual(deployed, predicted))
      throw new Error("Deployment address did not match its funded address");
    return deployed;
  };
  const execute = async (invocation: Invocation): Promise<void> => {
    const hash = await wallet.execute({ invocation, gasLimit: GAS_LIMIT });
    requireSuccess((await wallet.waitForTransactionReceipt(hash)).execResult);
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
    if (
      airdrop.status.result !== "ok" ||
      (await wallet.getBalance()).rawBalance < CONTRACT_FUNDING * 6n
    ) {
      throw new Error(
        "Infrastructure deployer airdrop did not provide the required HOG reserve",
      );
    }
    // Native-token storage also needs a reserve for future user allowance rows.
    await execute(
      ERC20.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
        receiver: HOG_ADDRESS,
        amount: CONTRACT_FUNDING,
      }),
    );
    // The node persists attached code only when deploy_contract consumes it.
    // These uninitialized instances register infrastructure code, not a pool.
    // ERC20 must instead be attached to the first user-created pair transaction:
    // registering it here would require deploying a forbidden token instance.
    await deploy(handler!);
    await deploy(driver!);
    const factory = await deploy(factoryContract!);
    const router = await deploy(routerContract!);
    await execute(
      SwapFactory.initialize.invocation(factory, GAS_LIMIT, {
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
      SwapRouter.initialize.invocation(router, GAS_LIMIT, { factory }),
    );
    const options = { client, contract: factory, caller: account.address };
    const count = (await SwapFactory.allPairsLength.view(options)).value;
    const funding = (await SwapFactory.poolFunding.view(options)).value;
    if (
      count !== 0n ||
      funding.min <= 0n ||
      funding.recommended < funding.min ||
      funding.recommended > ((1n << 128n) - 1n) / 3n
    ) {
      throw new Error(
        "Factory must have no pools and a valid native funding policy",
      );
    }
    await writeFile(
      temporary,
      renderEnvironment(toHex0x(expectedNetwork), rpcUrl, {
        factory,
        router,
        tokenHash,
      }),
    );
    // Publish complete code bytes before the environment completion marker.
    await publishArtifact(temporaryArtifact, artifactPath);
    await rename(temporary, environmentPath);
    console.log(
      `Local swap infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toHex0x(factory)}\nRouter: ${toHex0x(router)}`,
    );
    console.warn(
      `No pools or tokens were created. First pair creation can attach the code asset at ${artifactPath}.`,
    );
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryArtifact, { force: true });
  }
}

export function renderEnvironment(
  network: string,
  rpcUrl: string,
  deployment: {
    factory: ContractAddress;
    router: ContractAddress;
    tokenHash: Uint8Array;
  },
): string {
  return [
    `VITE_GROUNDHOG_RPC_URL=${rpcUrl}`,
    `VITE_GROUNDHOG_NETWORK_ID=${network}`,
    `VITE_NATIVE_HOG_ADDRESS=${toHex0x(HOG_ADDRESS)}`,
    `VITE_SWAP_FACTORY_ADDRESS=${toHex0x(deployment.factory)}`,
    `VITE_SWAP_ROUTER_ADDRESS=${toHex0x(deployment.router)}`,
    `VITE_POOL_TOKEN_HASH=${toHex0x(deployment.tokenHash)}`,
    "",
  ].join("\n");
}

export function validateLocalRpcUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("?") ||
    value.includes("#") ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Local setup requires a loopback HTTP RPC URL");
  }
  return url.href;
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

async function readNetworkHash() {
  let expected =
    process.env.GROUNDHOG_NETWORK_ID === undefined
      ? undefined
      : normalizeNetworkHash(process.env.GROUNDHOG_NETWORK_ID);
  if (process.env.GROUNDHOG_RUNTIME_MANIFEST) {
    const manifest = JSON.parse(
      await readFile(
        resolve(repositoryRoot, process.env.GROUNDHOG_RUNTIME_MANIFEST),
        "utf8",
      ),
    ) as { networkHash: string };
    if (typeof manifest.networkHash !== "string")
      throw new Error("Runtime manifest is missing networkHash");
    const recorded = normalizeNetworkHash(manifest.networkHash);
    if (expected !== undefined && expected !== recorded) {
      throw new Error("Runtime manifest and GROUNDHOG_NETWORK_ID disagree");
    }
    expected = recorded;
  }
  expected ??= `0x${"00".repeat(32)}`;
  return networkHash(sha256Hash(fromHex0x(expected)));
}

function normalizeNetworkHash(value: string): string {
  const match = /^(?:0x)?([0-9a-f]{64})$/i.exec(value);
  if (!match) throw new Error("Invalid local network hash");
  return `0x${match[1]!.toLowerCase()}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
