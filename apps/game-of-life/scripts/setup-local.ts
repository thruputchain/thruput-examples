import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  bytesEqual,
  createGroundhogClient,
  createSourceAddressAccount,
  createWalletClient,
  deriveContractAddress,
  devWalletAdapter,
  fixedBytes,
  hashContract,
  HttpTransport,
  localnet,
  PrivateKeySigner,
  toHex0x,
  type ConnectedGroundhogClient,
  type CoreGroundhogClient,
  type ExecutableWalletClient,
  type SourceAddressAccount,
  type TransactionReceipt,
} from "@groundhogchain/client";
import { DevWallet, ERC20 } from "@groundhogchain/client/contracts";
import {
  loadLocalDevAccount,
  type LocalDevAccount,
} from "@groundhogchain/client/local-dev";
import {
  bitMap,
  ContractType,
  ExecResult,
  gasAmount,
  HOG_ADDRESS,
  sha256Hash,
  weight,
  type Contract,
  type ContractAddress,
  type SHA256Hash,
} from "@groundhogchain/protocol";

import {
  GameOfLife,
  type WorldMetadata,
} from "../src/contracts/generated/game-of-life";

const DEV_WALLET_HASH =
  "0x2ce57271ea4453163dc83b78908f1cd2983cf12a9fbb4709004b7db0757825f2";
const RAW_UNITS_PER_HOG = 10_000_000n;
const PERSONA_FUNDING = 1_000n * RAW_UNITS_PER_HOG;
const SETUP_GAS = gasAmount(100_000_000n);
const INITIALIZE_EXPIRY = 1_000n;
const MAX_QUEUE_LENGTH = 64n;
const EXPECTED_POPULATION = 49_999_272n;
const EXPECTED_DIGEST =
  "0x85d72e50016badafcf3bc5c7040d42900b0417c3adc6721015aa1147d6733e05";
const PERSONAS = [
  { id: "alice", label: "Alice" },
  { id: "bob", label: "Bob" },
  { id: "carol", label: "Carol" },
] as const;

interface RuntimeManifest {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly chainState: string;
  readonly networkHash: string;
  readonly producer: {
    readonly binary: string;
    readonly version: string;
    readonly commitHash: string;
  };
  readonly bootstrapAccountDerivation: {
    readonly scheme: string;
    readonly seed: string;
  };
  readonly bootstrapAccounts: readonly {
    readonly index: number;
    readonly role: "faucet" | "local_user";
    readonly publicKey: string;
    readonly walletAddress: string;
  }[];
  readonly bootstrap: {
    readonly devWallet: {
      readonly contentHash: string;
      readonly deployEntrypoint: string;
      readonly createWalletEntrypoint: string;
      readonly doActionEntrypoint: string;
    };
    readonly storageCostModel: {
      readonly hash: string;
      readonly baseDataItemCost: string;
      readonly bytestringCostPerByte: string;
      readonly baseContractDeploymentCost: string;
      readonly contractDeploymentCostPerByte: string;
      readonly authPerKeyCost: string;
      readonly rcqCostPerEntry: string;
      readonly replayCacheCostPerEntry: string;
      readonly balanceCost: string;
    };
  };
}

type SetupWallet = ExecutableWalletClient<
  ConnectedGroundhogClient,
  SourceAddressAccount
>;

async function main(): Promise<void> {
  const manifestPath = resolve(required("GROUNDHOG_RUNTIME_MANIFEST"));
  const artifactRoot = resolve(required("GAME_OF_LIFE_ARTIFACT_ROOT"));
  const rpcUrl = loopbackOrigin(
    required("GROUNDHOG_RPC_URL"),
    "GROUNDHOG_RPC_URL",
  );
  const indexerUrl = loopbackOrigin(
    required("GAME_OF_LIFE_INDEXER_URL"),
    "GAME_OF_LIFE_INDEXER_URL",
  );
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as RuntimeManifest;
  const costs = validateManifest(manifest);

  const [readClient, faucetClient, aliceClient] = await Promise.all([
    connect(rpcUrl),
    connect(rpcUrl),
    connect(rpcUrl),
  ]);
  const version = await readClient.getVersion();
  if (!/^5\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version.wireFormat)) {
    throw new Error(
      `Groundhog wire format 5.x is required; found ${version.wireFormat}`,
    );
  }
  const rpcNetworkHash = toHex0x(readClient.network.networkHash).slice(2);
  if (rpcNetworkHash !== manifest.networkHash) {
    throw new Error(
      `The runtime manifest belongs to network ${manifest.networkHash}, but the RPC serves ${rpcNetworkHash}`,
    );
  }

  const [faucet, ...users] = await Promise.all([
    loadLocalDevAccount({ role: "faucet" }),
    ...PERSONAS.map((_, roleOffset) =>
      loadLocalDevAccount({ role: "local_user", roleOffset }),
    ),
  ]);
  const personas = PERSONAS.map((identity, offset) =>
    createPersona(identity, users[offset]!, manifest),
  );
  const alice = users[0]!;
  const faucetWallet = bindWallet(faucetClient, faucet);
  const aliceWallet = bindWallet(aliceClient, alice);

  const artifactBytes = await readFile(
    join(artifactRoot, "game_of_life.rv32a"),
  );
  const contract: Contract = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: artifactBytes },
  };
  const contractHash = hashContract(contract);
  const deploymentNonce = sha256Hash(randomBytes(32));
  const contractAddress = deriveContractAddress(
    alice.address,
    deploymentNonce,
    contractHash,
  );
  const reserve = calculateReserve(costs, BigInt(artifactBytes.byteLength));
  const fundingAmount = reserve + costs.balanceCost;
  const personaFunding = PERSONA_FUNDING * BigInt(PERSONAS.length);
  const faucetBalance = (await readClient.getBalance(faucet.address))
    .rawBalance;
  if (faucetBalance <= fundingAmount + personaFunding) {
    throw new Error(
      `The local faucet has ${faucetBalance} raw HOG; setup requires more than ${fundingAmount + personaFunding}`,
    );
  }
  if ((await readClient.getBalance(alice.address)).rawBalance <= 0n) {
    throw new Error(
      "Alice needs native HOG for deployment and initialization fees",
    );
  }

  await transferHog(
    faucetWallet,
    readClient,
    contractAddress,
    fundingAmount,
    "contract prefunding",
  );
  const funded = (await readClient.getBalance(contractAddress)).rawBalance;
  if (funded < reserve) {
    throw new Error(
      `The deployment address has ${funded} raw HOG; expected at least ${reserve}`,
    );
  }

  const deployReceipt = await submitAndObserve(
    aliceWallet,
    () =>
      aliceWallet.sendInvocation({
        invocation: DevWallet.deploy.invocation(alice.address, SETUP_GAS, {
          nonce: fixedBytes(deploymentNonce, 32),
          contractHash: fixedBytes(contractHash, 32),
        }),
        contractsToDeploy: [contract],
        expiryBlocks: INITIALIZE_EXPIRY,
      }),
    INITIALIZE_EXPIRY,
    120_000,
    "deployment",
  );
  requireSuccess(deployReceipt, "deployment");
  const deployedAddress = DevWallet.deploy.decodeReceipt(deployReceipt).value;
  if (!bytesEqual(deployedAddress, contractAddress)) {
    throw new Error(
      `Deployment returned ${toHex0x(deployedAddress)}; expected ${toHex0x(contractAddress)}`,
    );
  }

  const initializationStarted = Date.now();
  await initializeWorld(
    resolve(artifactRoot, "../.."),
    rpcUrl,
    manifestPath,
    toHex0x(contractAddress),
  );
  const observed = (
    await GameOfLife.getMetadata.view({
      client: readClient,
      contract: contractAddress,
      caller: alice.address,
    })
  ).value;
  verifyMetadata(observed, "committed metadata");
  if (process.env.GAME_OF_LIFE_INITIALIZATION_MS_FILE) {
    await writeFile(
      process.env.GAME_OF_LIFE_INITIALIZATION_MS_FILE,
      `${Date.now() - initializationStarted}\n`,
      { mode: 0o600 },
    );
  }

  for (const user of users) {
    await transferHog(
      faucetWallet,
      readClient,
      user.address,
      PERSONA_FUNDING,
      `funding local user ${user.index}`,
    );
  }

  await publishEnvironment(
    rpcUrl,
    manifest.networkHash,
    toHex0x(contractAddress),
    indexerUrl,
    personas,
  );
  process.stdout.write(
    `Game of Life setup complete\nContract: ${toHex0x(contractAddress)}\n`,
  );
}

async function connect(rpcUrl: string): Promise<ConnectedGroundhogClient> {
  return createGroundhogClient({
    cluster: localnet({ rpcUrl }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 10_000 }),
  });
}

function bindWallet(
  client: ConnectedGroundhogClient,
  local: LocalDevAccount,
): SetupWallet {
  return createWalletClient({
    client,
    account: createSourceAddressAccount({
      address: local.address,
      signers: [{ signer: local.signer, publicKeyId: 0n }],
      allowedKeys: bitMap(1n),
      requiredWeight: weight(1n),
    }),
    invocationAdapter: devWalletAdapter,
  });
}

function createPersona(
  identity: (typeof PERSONAS)[number],
  local: LocalDevAccount,
  manifest: RuntimeManifest,
) {
  const recorded = manifest.bootstrapAccounts.find(
    ({ index }) => index === local.index,
  );
  if (
    recorded?.role !== "local_user" ||
    recorded.walletAddress !== toHex0x(local.address)
  ) {
    throw new Error(`${identity.label}'s account does not match the manifest`);
  }
  const privateKey = createHash("sha256")
    .update(
      `${manifest.bootstrapAccountDerivation.seed}:account-${local.index}`,
    )
    .digest();
  if (
    !bytesEqual(
      new PrivateKeySigner(privateKey).publicKey.ed25519,
      hexBytes(recorded.publicKey, `${identity.label}'s public key`, 32),
    )
  ) {
    throw new Error(`${identity.label}'s signer does not match the manifest`);
  }
  return {
    ...identity,
    privateKey: toHex0x(privateKey),
    signerPublicKey: recorded.publicKey,
    walletRoot: recorded.walletAddress,
    walletEntrypoint: toHex0x(DevWallet.doAction.entrypoint),
    expectedCaller: recorded.walletAddress,
    callerVerified: true,
  };
}

function validateManifest(manifest: RuntimeManifest) {
  if (manifest.schemaVersion !== 2)
    throw new Error(
      `Runtime manifest schema 2 is required; found ${manifest.schemaVersion}`,
    );
  if (manifest.kind !== "hogd-dev-runtime")
    throw new Error(
      `Expected a hogd-dev-runtime manifest; found ${manifest.kind}`,
    );
  if (manifest.chainState !== "fresh")
    throw new Error(
      `Setup requires a freshly started ledger; found ${manifest.chainState}`,
    );
  if (manifest.producer.binary !== "hog-devnode")
    throw new Error(`Expected hog-devnode; found ${manifest.producer.binary}`);
  if (manifest.producer.version !== "0.1.26")
    throw new Error(
      `hog-devnode 0.1.26 is required; found ${manifest.producer.version}`,
    );
  if (!manifest.producer.commitHash)
    throw new Error("Runtime manifest producer commitHash is required");
  if (!/^[0-9a-f]{64}$/.test(manifest.networkHash))
    throw new Error("Runtime manifest networkHash must be lowercase hex32");
  if (
    manifest.bootstrapAccountDerivation.scheme !==
    "groundhog-bootstrap-account-v1"
  ) {
    throw new Error(
      `Unsupported bootstrap derivation scheme: ${manifest.bootstrapAccountDerivation.scheme}`,
    );
  }
  if (manifest.bootstrap.devWallet.contentHash !== DEV_WALLET_HASH) {
    throw new Error(
      `Unsupported DevWallet content hash ${manifest.bootstrap.devWallet.contentHash}; expected ${DEV_WALLET_HASH}`,
    );
  }
  const entrypoints = [
    ["deployEntrypoint", toHex0x(DevWallet.deploy.entrypoint)],
    ["createWalletEntrypoint", toHex0x(DevWallet.createWallet.entrypoint)],
    ["doActionEntrypoint", toHex0x(DevWallet.doAction.entrypoint)],
  ] as const;
  for (const [field, expected] of entrypoints) {
    const actual = manifest.bootstrap.devWallet[field];
    if (actual !== expected) {
      throw new Error(
        `Runtime manifest ${field} is ${actual}; expected ${expected}`,
      );
    }
  }
  if (!/^0x[0-9a-f]{64}$/.test(manifest.bootstrap.storageCostModel.hash))
    throw new Error("Runtime manifest storage-cost hash is invalid");
  if (!manifest.bootstrapAccounts.some(({ role }) => role === "faucet"))
    throw new Error("The local node runtime manifest must include a faucet");
  if (
    manifest.bootstrapAccounts.filter(({ role }) => role === "local_user")
      .length < PERSONAS.length
  ) {
    throw new Error(
      "The local node must expose Alice, Bob, and Carol accounts",
    );
  }
  const values = manifest.bootstrap.storageCostModel;
  return {
    baseDataItemCost: decimal(values.baseDataItemCost, "baseDataItemCost"),
    bytestringCostPerByte: decimal(
      values.bytestringCostPerByte,
      "bytestringCostPerByte",
    ),
    baseContractDeploymentCost: decimal(
      values.baseContractDeploymentCost,
      "baseContractDeploymentCost",
    ),
    contractDeploymentCostPerByte: decimal(
      values.contractDeploymentCostPerByte,
      "contractDeploymentCostPerByte",
    ),
    rcqCostPerEntry: decimal(values.rcqCostPerEntry, "rcqCostPerEntry"),
    balanceCost: decimal(values.balanceCost, "balanceCost"),
    authPerKeyCost: decimal(values.authPerKeyCost, "authPerKeyCost"),
    replayCacheCostPerEntry: decimal(
      values.replayCacheCostPerEntry,
      "replayCacheCostPerEntry",
    ),
  };
}

function calculateReserve(
  costs: ReturnType<typeof validateManifest>,
  artifactBytes: bigint,
): bigint {
  const raw =
    40_004n * costs.baseDataItemCost +
    25_001_024n * costs.bytestringCostPerByte +
    MAX_QUEUE_LENGTH * costs.rcqCostPerEntry +
    costs.baseContractDeploymentCost +
    artifactBytes * costs.contractDeploymentCostPerByte;
  return (
    ((raw + RAW_UNITS_PER_HOG - 1n) / RAW_UNITS_PER_HOG) * RAW_UNITS_PER_HOG
  );
}

async function transferHog(
  wallet: SetupWallet,
  observer: CoreGroundhogClient,
  receiver: ContractAddress,
  amount: bigint,
  operation: string,
): Promise<void> {
  const receipt = await submitAndObserve(
    observer,
    () =>
      wallet.execute({
        invocation: ERC20.transfer.invocation(HOG_ADDRESS, SETUP_GAS, {
          receiver,
          amount,
        }),
        gasLimit: SETUP_GAS,
        expiryBlocks: INITIALIZE_EXPIRY,
      }),
    INITIALIZE_EXPIRY,
    120_000,
    operation,
  );
  requireSuccess(receipt, operation);
}

async function submitAndObserve(
  client: CoreGroundhogClient,
  submit: () => Promise<SHA256Hash>,
  expiryBlocks: bigint,
  timeoutMs: number,
  operation: string,
): Promise<TransactionReceipt> {
  const submittedAt = await client.getChainTip();
  const hash = await submit();
  const hashHex = toHex0x(hash);
  const expiryHeight = submittedAt.height + expiryBlocks;
  const deadline = Date.now() + timeoutMs;
  let observedStatus = "";
  process.stdout.write(`Submitted ${operation}: ${hashHex}\n`);
  while (true) {
    const receipt = await client.getTransactionReceipt(hash);
    if (receipt) return receipt;
    const status = await client.getTransactionStatus(hash);
    if (status.status !== observedStatus) {
      process.stdout.write(`${operation} ${hashHex}: ${status.status}\n`);
      observedStatus = status.status;
    }
    if (status.status === "invalid") {
      throw new Error(`${operation} ${hashHex} is invalid: ${status.reason}`);
    }
    const tip = await client.getChainTip();
    if (tip.height >= expiryHeight) {
      const finalReceipt = await client.getTransactionReceipt(hash);
      if (finalReceipt) return finalReceipt;
      throw new Error(
        `${operation} ${hashHex} expired without a receipt; start a fresh disposable node before retrying setup`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${operation} ${hashHex} is still ${status.status}; inspect it before starting a fresh disposable node instead of rerunning setup`,
      );
    }
    await wait(500);
  }
}

function requireSuccess(receipt: TransactionReceipt, operation: string): void {
  if (receipt.execResult !== ExecResult.ExecResultOK) {
    const abort = receipt.abortData ? toHex0x(receipt.abortData) : "none";
    throw new Error(
      `${operation} ${toHex0x(receipt.txHash)} failed with ${ExecResult[receipt.execResult]}; abort=${abort}`,
    );
  }
}

async function initializeWorld(
  repoRoot: string,
  rpcUrl: string,
  manifestPath: string,
  contractAddress: string,
): Promise<void> {
  await new Promise<void>((resolveInitialization, rejectInitialization) => {
    const child = spawn(
      "cargo",
      [
        "test",
        "-p",
        "game-of-life-live-test",
        "--release",
        "--test",
        "feasibility",
        "initializes_complete_world",
        "--locked",
        "--",
        "--ignored",
        "--exact",
        "--nocapture",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GROUNDHOG_RPC_URL: rpcUrl,
          GROUNDHOG_RUNTIME_MANIFEST: manifestPath,
          GROUNDHOG_CONTRACT_ADDRESS: contractAddress,
          GAME_OF_LIFE_OUTER_GAS: "60000000000",
          GAME_OF_LIFE_TARGET_GAS: "59000000000",
          GAME_OF_LIFE_TIMEOUT_SECONDS: "600",
        },
        stdio: "inherit",
      },
    );
    child.once("error", rejectInitialization);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveInitialization();
        return;
      }
      rejectInitialization(
        new Error(
          `World initialization failed${code !== null ? ` with exit code ${code}` : ` from ${signal ?? "an unknown signal"}`}`,
        ),
      );
    });
  });
}

function verifyMetadata(value: WorldMetadata, source: string): void {
  if (
    value.width !== 10_000n ||
    value.height !== 10_000n ||
    value.generation !== 0n ||
    value.seed !== 0n ||
    value.population !== EXPECTED_POPULATION ||
    toHex0x(value.state_digest) !== EXPECTED_DIGEST ||
    value.chunk_bytes !== 1_000n ||
    value.chunks_per_row !== 2n ||
    value.max_queue_len !== MAX_QUEUE_LENGTH
  ) {
    throw new Error(`${source} does not match the expected seed-zero world`);
  }
}

async function publishEnvironment(
  rpcUrl: string,
  networkHash: string,
  contractAddress: string,
  indexerUrl: string,
  personas: ReturnType<typeof createPersona>[],
): Promise<void> {
  const output = [
    `VITE_GROUNDHOG_RPC_URL=${rpcUrl}`,
    `VITE_GROUNDHOG_NETWORK_ID=${networkHash}`,
    `VITE_GAME_OF_LIFE_CONTRACT_ADDRESS=${contractAddress}`,
    `VITE_GAME_OF_LIFE_INDEXER_URL=${indexerUrl}`,
    "VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT=100000",
    "VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT=100000",
    "VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS=64",
    "VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS=30000",
    "VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT=10010000000",
    "VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT=10000000000",
    "VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS=2",
    "VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS=300000",
    `GROUNDHOG_DEV_PERSONAS=${JSON.stringify(personas)}`,
    "",
  ].join("\n");
  const destination = resolve(import.meta.dirname, "../.env.local");
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, output, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
  process.stdout.write(
    `Wrote verified loopback configuration to ${destination}\n`,
  );
}

function decimal(value: string, name: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error(
      `Runtime manifest ${name} must be a nonnegative decimal integer`,
    );
  return BigInt(value);
}

function hexBytes(value: string, name: string, length: number): Uint8Array {
  if (!new RegExp(`^0x[0-9a-f]{${length * 2}}$`).test(value))
    throw new Error(`${name} must be canonical lowercase hex`);
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loopbackOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a credential-free loopback HTTP origin`);
  }
  return url.href.replace(/\/$/, "");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
