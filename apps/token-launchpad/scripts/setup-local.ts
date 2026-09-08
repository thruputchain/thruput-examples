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

import {
  StandardTokenFactory,
  type FactoryConfig,
} from "../src/contracts/generated/standard-token-factory";
import { PINNED_NATIVE_BALANCE_ITEM_COST } from "../src/runtime";

const GAS_LIMIT = gasAmount(10_000_000n);
const CONTRACT_FUNDING = 10_000_000n;
const REQUIRED_TOKEN_FUNDING = 350_770n;

export async function main(): Promise<void> {
  const artifactRoot = resolve(requiredEnvironment("LAUNCHPAD_ARTIFACT_ROOT"));
  const environmentPath = resolve(requiredEnvironment("LAUNCHPAD_APP_ENV"));
  const artifactDirectory = join(
    resolve(
      process.env.LAUNCHPAD_APP_PUBLIC_DIR ??
        fileURLToPath(new URL("../public", import.meta.url)),
    ),
    "contract-artifacts",
  );
  const rpcUrl = validateLocalRpcUrl(requiredEnvironment("GROUNDHOG_RPC_URL"));
  const { expectedNetwork, costs } = await readRuntime();
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
  const [tokenContract, factoryContract] = await Promise.all(
    ["standard_token", "standard_token_factory"].map(
      async (name): Promise<Contract> => ({
        contract_type: ContractType.kRv32,
        rv32_contract: {
          data: await readFile(join(artifactRoot, `${name}.rv32a`)),
        },
      }),
    ),
  );
  const tokenHash = hashContract(tokenContract!);
  const artifactPath = join(artifactDirectory, `${toHex0x(tokenHash)}.json`);
  if (tokenContract?.contract_type !== ContractType.kRv32)
    throw new Error("Expected an RV32 token artifact");
  validateTokenFunding(costs, tokenContract.rv32_contract.data.length);
  const artifactContents = `${JSON.stringify({ contractType: "rv32", data: toHex0x(tokenContract.rv32_contract.data), hash: toHex0x(tokenHash) })}\n`;

  // Tool-only deployer: never export the key or account to browser configuration.
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  const requireSuccess = (result: ExecResult): void => {
    if (result !== ExecResult.ExecResultOK) {
      throw new Error(`Setup transaction failed with ${ExecResult[result]}`);
    }
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
    await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
    await writeFile(temporaryArtifact, artifactContents, {
      mode: 0o644,
      flag: "wx",
    });
    const airdrop = await wallet.requestAirdrop();
    if (
      airdrop.status.result !== "ok" ||
      (await wallet.getBalance()).rawBalance < CONTRACT_FUNDING * 3n
    ) {
      throw new Error(
        "Infrastructure deployer airdrop did not provide the required HOG reserve",
      );
    }
    // Unused contractsToDeploy attachments are not persisted by the node.
    // The first user token creation must attach standard_token.rv32a; setup
    // deliberately does not instantiate a token just to register its code.
    const nonce = sha256Hash(randomBytes(32));
    const factoryHash = hashContract(factoryContract!);
    const predicted = deriveContractAddress(
      account.address,
      nonce,
      factoryHash,
    );
    // DefaultWallet.deploy does not fund the deployment's storage automatically.
    for (const receiver of [HOG_ADDRESS, predicted]) {
      await execute(
        ERC20.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
          receiver,
          amount: CONTRACT_FUNDING,
        }),
      );
    }
    const hash = await wallet.sendInvocation({
      invocation: DefaultWallet.deploy.invocation(account.address, GAS_LIMIT, {
        nonce: fixedBytes(nonce, 32),
        contractHash: fixedBytes(factoryHash, 32),
      }),
      contractsToDeploy: [factoryContract!],
    });
    const receipt = await wallet.waitForTransactionReceipt(hash);
    requireSuccess(receipt.execResult);
    const factoryAddress = DefaultWallet.deploy.decodeReceipt(receipt).value;
    if (!bytesEqual(factoryAddress, predicted))
      throw new Error("Deployment address did not match its funded address");
    const expectedConfig: FactoryConfig = {
      token_code_hash: fixedBytes(tokenHash, 32),
      required_token_funding: REQUIRED_TOKEN_FUNDING,
      native_token: HOG_ADDRESS,
      creation_fee: 0n,
      fee_recipient: null,
    };
    await execute(
      StandardTokenFactory.initialize.invocation(factoryAddress, GAS_LIMIT, {
        config: expectedConfig,
      }),
    );
    const observed = (
      await StandardTokenFactory.config.view({
        client,
        contract: factoryAddress,
        caller: account.address,
      })
    ).value;
    if (
      !bytesEqual(observed.token_code_hash, tokenHash) ||
      observed.required_token_funding !== REQUIRED_TOKEN_FUNDING ||
      !bytesEqual(observed.native_token, HOG_ADDRESS) ||
      observed.creation_fee !== 0n ||
      observed.fee_recipient !== null
    ) {
      throw new Error(
        "The deployed factory configuration could not be verified",
      );
    }
    await writeFile(
      temporary,
      renderEnvironment({
        rpcUrl,
        networkHash: toHex0x(expectedNetwork),
        factoryAddress,
        tokenHash,
      }),
    );
    // Publish complete code bytes before the environment completion marker.
    await publishArtifact(temporaryArtifact, artifactPath);
    await rename(temporary, environmentPath);
    console.log(
      `Local launchpad infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toHex0x(factoryAddress)}`,
    );
    console.warn(
      `No tokens were created. First token creation can attach the code asset at ${artifactPath}.`,
    );
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryArtifact, { force: true });
  }
}

export function renderEnvironment(input: {
  rpcUrl: string;
  networkHash: string;
  factoryAddress: ContractAddress;
  tokenHash: Uint8Array;
}): string {
  return [
    `VITE_GROUNDHOG_RPC_URL=${input.rpcUrl}`,
    `VITE_GROUNDHOG_NETWORK_ID=${input.networkHash}`,
    `VITE_NATIVE_HOG_ADDRESS=${toHex0x(HOG_ADDRESS)}`,
    `VITE_NATIVE_BALANCE_ITEM_COST=${PINNED_NATIVE_BALANCE_ITEM_COST}`,
    `VITE_STANDARD_TOKEN_FACTORY_ADDRESS=${toHex0x(input.factoryAddress)}`,
    `VITE_STANDARD_TOKEN_HASH=${toHex0x(input.tokenHash)}`,
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

async function readRuntime() {
  let expected =
    process.env.GROUNDHOG_NETWORK_ID === undefined
      ? undefined
      : normalizeNetworkHash(process.env.GROUNDHOG_NETWORK_ID);
  const manifest = JSON.parse(
    await readFile(
      resolve(requiredEnvironment("GROUNDHOG_RUNTIME_MANIFEST")),
      "utf8",
    ),
  ) as {
    networkHash: string;
    bootstrap?: { storageCostModel?: unknown };
  };
  const costs = manifest.bootstrap?.storageCostModel;
  if (typeof manifest.networkHash !== "string")
    throw new Error("Runtime manifest is missing networkHash");
  const recorded = normalizeNetworkHash(manifest.networkHash);
  if (expected !== undefined && expected !== recorded) {
    throw new Error("Runtime manifest and GROUNDHOG_NETWORK_ID disagree");
  }
  expected = recorded;
  return {
    expectedNetwork: networkHash(sha256Hash(fromHex0x(expected))),
    costs,
  };
}

export function validateTokenFunding(
  costs: unknown,
  artifactBytes: number,
): void {
  // Same storage profile as the legacy local-environment validator, without
  // any bootstrap-account or persona requirements.
  const profile = {
    hash: "0x7fcd5d27353800caf9f8f3a73a030be49a1dcd9db4616792e7887746bea713ce",
    baseDataItemCost: "12000",
    bytestringCostPerByte: "10",
    baseContractDeploymentCost: "12000",
    contractDeploymentCostPerByte: "10",
    authPerKeyCost: "1111",
    rcqCostPerEntry: "8",
    replayCacheCostPerEntry: "7",
    balanceCost: PINNED_NATIVE_BALANCE_ITEM_COST.toString(),
  };
  if (typeof costs !== "object" || costs === null)
    throw new Error("Runtime manifest must include storageCostModel");
  for (const [field, expected] of Object.entries(profile)) {
    const actual = (costs as Record<string, unknown>)[field];
    if (actual !== expected)
      throw new Error(`Unsupported runtime storage cost: ${field}`);
  }
  // initialize_once writes Config and at most holder + total_supply NNInt rows.
  // Config's conservative XDR bound is 168 bytes: address 32, optional name
  // (100 bytes) 108, optional symbol (10 bytes padded to 12) 20, decimals 8.
  // Include native balance bookkeeping as well. No token auth/RCQ/replay rows
  // are created: the factory invokes the initializer as a nested call.
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 0)
    throw new Error("Invalid token artifact size");
  const maximumCost =
    12_000n +
    BigInt(artifactBytes) * 10n +
    12_000n +
    168n * 10n +
    2n * 12_000n +
    PINNED_NATIVE_BALANCE_ITEM_COST;
  if (maximumCost > REQUIRED_TOKEN_FUNDING) {
    throw new Error(
      `Token artifact exceeds the ${REQUIRED_TOKEN_FUNDING} deployment/initialization funding budget`,
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

function normalizeNetworkHash(value: string): string {
  const match = /^(?:0x)?([0-9a-f]{64})$/i.exec(value);
  if (!match) throw new Error("Invalid local network hash");
  return `0x${match[1]!.toLowerCase()}`;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
