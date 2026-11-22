import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createDefaultWalletBatchInvocation,
  createThruputClient,
  defineCluster,
  fixedBytes,
  hashContract,
  hashFromBase58,
  hashSignedTransaction,
  HttpTransport,
  prepareContractDeployment,
  rv32Contract,
  serializeSignedTransaction,
  toBase58,
  toHex0x,
  type ContractAddress,
  type StorageCosts,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  blockHeight,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
  networkHash,
} from "@thruputchain/protocol";
import { errorMessage } from "../src/config";
import { NftDrop } from "../src/contracts/generated/nft-drop";
import { NftDropFactory } from "../src/contracts/generated/nft-drop-factory";
import { DEMO_DROP } from "../src/contracts/drops";
import {
  crowdAccount,
  crowdFunding,
  MAX_CROWD_SIZE,
  MIN_CROWD_BALANCE,
} from "../server/crowd";
import {
  createPersona,
  createRun,
  record,
  saveRun,
  type Client,
  type Persona,
  type Run,
} from "./run";

const wait = { timeoutMs: 60_000 };
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const BLOCK_INTERVAL_MS = 2_000n;
// A DefaultWallet batch takes at most 16 calls.
const TRANSFERS_PER_BATCH = 16;
const BATCHES_IN_FLIGHT = 50;

export async function setup(
  env: Record<string, string | undefined> = process.env,
) {
  const rpcUrl = env.THRUPUT_RPC_URL ?? "http://127.0.0.1:9545";
  let networkId = env.THRUPUT_NETWORK_ID || undefined;
  // A manifest is optional. If supplied, it must agree with THRUPUT_NETWORK_ID.
  if (env.THRUPUT_RUNTIME_MANIFEST) {
    const manifest: { networkHash?: unknown } = JSON.parse(
      await readFile(
        resolve(repositoryRoot, env.THRUPUT_RUNTIME_MANIFEST),
        "utf8",
      ),
    );
    const recorded = String(manifest.networkHash);
    if (networkId !== undefined && networkId !== recorded)
      throw new Error("Runtime manifest and THRUPUT_NETWORK_ID disagree.");
    networkId = recorded;
  }
  const crowdSize = Number(env.NFT_CROWD_SIZE ?? MAX_CROWD_SIZE);
  if (
    !Number.isInteger(crowdSize) ||
    crowdSize < 1 ||
    crowdSize > MAX_CROWD_SIZE
  )
    throw new Error(`NFT_CROWD_SIZE must be 1–${MAX_CROWD_SIZE}.`);

  // The SDK discovers the network and checks an explicit pin before signing.
  const client = await createThruputClient({
    cluster: defineCluster({
      name: "local",
      rpcUrl,
      capabilities: ["airdrop"] as const,
      ...(networkId === undefined
        ? {}
        : { networkHash: networkHash(hashFromBase58(networkId)) }),
    }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 30_000 }),
  });
  const output =
    env.NFT_DROP_APP_ENV ||
    fileURLToPath(new URL("../.env.local", import.meta.url));
  const [dropCode, factoryCode] = await Promise.all([
    readFile(join(repositoryRoot, "target/thruput/nft_drop.rv32a")),
    readFile(join(repositoryRoot, "target/thruput/nft_drop_factory.rv32a")),
  ]);
  const costs = (await client.getChainConfig()).execution?.storageCosts;
  if (!costs) throw new Error("The node did not report its storage costs.");

  await useIntervalBlocks(client);

  const run = await createRun(
    join(dirname(resolve(output)), ".local", "nft-drop-setup"),
    toBase58(client.network.networkHash),
  );
  console.log(`Run: ${run.directory}`);
  try {
    const persona = await createPersona(client, run, "NFT Drop Operator");
    const funding = fundingRates(costs);
    const crowdEach = crowdFunding(costs);
    const demoFunding =
      funding.base + funding.perToken * BigInt(DEMO_DROP.supply);
    // The crowd, the demo drop, the factory, and scheduling headroom.
    await fundPersona(
      run,
      persona,
      BigInt(crowdSize) * crowdEach + demoFunding + 200_000_000n,
    );

    const factory = await deployFactory(
      run,
      persona,
      factoryCode,
      hashContract(rv32Contract(dropCode)),
      funding,
    );
    const demoDrop = await createDemoDrop(
      client,
      run,
      persona,
      factory,
      dropCode,
      demoFunding,
    );

    const crowdSeed = randomBytes(32);
    await fundCrowd(client, run, persona, crowdSeed, crowdSize, crowdEach);
    await verify(client, persona, factory, demoDrop);

    await writeEnvironment(output, {
      THRUPUT_RPC_URL: rpcUrl,
      VITE_THRUPUT_NETWORK_ID: run.manifest.networkHash,
      VITE_NFT_DROP_FACTORY: toBase58(factory),
      NFT_CROWD_SEED: toHex0x(crowdSeed),
      NFT_CROWD_SIZE: String(crowdSize),
      PORT: "3000",
    });
    run.manifest.status = "complete";
    await saveRun(run);
    console.log(
      `NFT Drop ready.\nFactory: ${toBase58(factory)}\nDemo drop: ${toBase58(demoDrop)}\nCrowd: ${crowdSize} funded accounts\nEnvironment: ${output}`,
    );
  } catch (error) {
    run.manifest.status = "failed";
    run.manifest.error = errorMessage(error);
    await saveRun(run);
    throw error;
  }
}

/**
 * A new local node makes one block for each transaction, so every mint would
 * get its own block. Switch it to 2-second blocks, close to devnet's.
 */
async function useIntervalBlocks(client: Client) {
  if (
    !client.discovery.version.supportedMethods.includes("dev_setBlockDriver")
  ) {
    console.log(
      "The node has no dev_setBlockDriver; leaving its block mode unchanged.",
    );
    return;
  }
  await client.dev_setBlockDriver({
    mode: "interval",
    intervalMilliseconds: BLOCK_INTERVAL_MS,
  });
  console.log(
    `Switched the local node to ${BLOCK_INTERVAL_MS} ms interval blocks.`,
  );
}

/**
 * Storage a drop pays for, with headroom, from the node's reported costs:
 * a base for its configuration, traits, and counters, and an amount for each
 * token's owner, traits, and new owner balance.
 */
export function fundingRates(costs: StorageCosts) {
  const item =
    BigInt(costs.baseDataItemCost) +
    1_024n * BigInt(costs.bytestringCostPerByte);
  const token =
    BigInt(costs.baseDataItemCost) + 64n * BigInt(costs.bytestringCostPerByte);
  return { base: 60n * item, perToken: 3n * token + BigInt(costs.balanceCost) };
}

async function fundPersona(run: Run, persona: Persona, minimum: bigint) {
  let balance = (await persona.wallet.getBalance()).rawBalance;
  while (balance < minimum) {
    await record(run, `Fund ${persona.name}`, async () => {
      // The faucet chooses the amount and waits for successful execution.
      const funding = await persona.wallet.requestAirdrop(wait);
      return {
        hash: funding.transactionHash,
        blockHeight: funding.blockHeight,
      };
    });
    const next = (await persona.wallet.getBalance()).rawBalance;
    if (next <= balance)
      throw new Error(
        "Funding is not visible yet. Inspect the last airdrop before continuing.",
      );
    balance = next;
  }
}

async function deployFactory(
  run: Run,
  persona: Persona,
  code: Uint8Array,
  dropCodeHash: Uint8Array,
  funding: ReturnType<typeof fundingRates>,
) {
  const deployment = prepareContractDeployment({
    deployer: persona.account.address,
    contract: code,
  });
  run.manifest.factoryAddress = toBase58(deployment.address);
  await saveRun(run);
  await record(run, "Deploy and initialize the factory", () =>
    // Funding, deployment, and initialization succeed or fail together.
    persona.wallet.deployContractAndWait(
      deployment,
      {
        gasLimit: gasAmount(20_000_000n),
        amount: 10_000_000n, // One native token for the factory's list.
        initializer: NftDropFactory.v0_1.initialize.invocation(
          deployment.address,
          gasAmount(2_000_000n),
          {
            config: {
              drop_code_hash: fixedBytes(dropCodeHash, 32),
              base_funding: funding.base,
              funding_per_token: funding.perToken,
            },
          },
        ),
      },
      wait,
    ),
  );
  return deployment.address;
}

/**
 * Create the first drop. The node stores the drop's code only when a
 * transaction attaches it and deploys it, so the first creation attaches it.
 * Later creations, including the browser's, deploy by code hash alone.
 */
async function createDemoDrop(
  client: Client,
  run: Run,
  persona: Persona,
  factory: ContractAddress,
  dropCode: Uint8Array,
  amount: bigint,
) {
  const nonce = fixedBytes(randomBytes(32), 32);
  const { value: predicted } = await NftDropFactory.v0_1.predictDrop.view({
    client,
    address: factory,
    args: { creator: persona.account.address, nonce },
    minStateBlockHeight: run.latestBlockHeight,
  });
  run.manifest.demoDropAddress = toBase58(predicted);
  await saveRun(run);
  await record(run, "Fund and create the demo drop", () =>
    persona.wallet.executeCallsAndWait(
      {
        calls: [
          ERC20.v0_1.transfer.call({
            address: NATIVE_TOKEN_ADDRESS,
            gasLimit: gasAmount(1_000_000n),
            args: { receiver: predicted, amount },
          }),
          NftDropFactory.v0_1.createDrop.call({
            address: factory,
            gasLimit: gasAmount(20_000_000n),
            args: { nonce, definition: DEMO_DROP },
          }),
        ],
        gasLimit: gasAmount(25_000_000n),
        contractsToDeploy: [rv32Contract(dropCode)],
      },
      wait,
    ),
  );
  return predicted;
}

/**
 * Give each crowd account enough native tokens to schedule mints. Accounts
 * that already hold enough are skipped, so a rerun funds only what is missing.
 *
 * Every batch is signed and saved before any is sent. The batches are
 * independent: a timeout leaves that batch unknown, and the next setup run
 * reads balances instead of resending it.
 */
async function fundCrowd(
  client: Client,
  run: Run,
  persona: Persona,
  seed: Uint8Array,
  size: number,
  amount: bigint,
) {
  const accounts = Array.from({ length: size }, (_, index) =>
    crowdAccount(seed, index),
  );
  const balances = await Promise.all(
    accounts.map((account) => client.getBalance({ address: account.address })),
  );
  const unfunded = accounts.filter(
    (_, index) => balances[index]!.rawBalance < MIN_CROWD_BALANCE,
  );
  const tip = await client.getChainTip();
  const signed = [];
  for (let start = 0; start < unfunded.length; start += TRANSFERS_PER_BATCH) {
    const recipients = unfunded.slice(start, start + TRANSFERS_PER_BATCH);
    const gasLimit = gasAmount(BigInt(recipients.length) * 50_000n + 200_000n);
    const invocation = createDefaultWalletBatchInvocation(
      persona.account.address,
      {
        gasLimit,
        invocations: recipients.map((account) =>
          ERC20.v0_1.transfer.invocation(
            NATIVE_TOKEN_ADDRESS,
            gasAmount(50_000n),
            {
              receiver: account.address,
              amount,
            },
          ),
        ),
      },
    );
    // The batch is the root invocation; it is not wrapped in another wallet call.
    const transaction = await persona.wallet.prepareTransaction({
      invocation,
      blockExpiryHeight: blockHeight(tip.blockHeight + 1_000n),
    });
    signed.push(await persona.wallet.signTransaction(transaction));
  }
  const label = `Fund ${unfunded.length} crowd accounts in ${signed.length} transactions`;
  const evidence = join(run.directory, "crowd-funding.signed.json");
  await writeFile(
    evidence,
    JSON.stringify(
      signed.map((transaction) => ({
        hash: toBase58(hashSignedTransaction(transaction)),
        signed: toHex0x(serializeSignedTransaction(transaction)),
      })),
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  run.manifest.transactions.push({ label, status: "unknown" });
  await saveRun(run);
  console.log(label);

  const failures: string[] = [];
  for (let start = 0; start < signed.length; start += BATCHES_IN_FLIGHT) {
    await Promise.all(
      signed
        .slice(start, start + BATCHES_IN_FLIGHT)
        .map(async (transaction) => {
          const hash = hashSignedTransaction(transaction);
          try {
            await client.sendTransaction({
              signedTransaction: serializeSignedTransaction(transaction),
            });
            const receipt = await client.waitForTransactionReceipt(hash, wait);
            if (
              !("result" in receipt.execution) ||
              receipt.execution.result !== "return"
            )
              failures.push(`${toBase58(hash)} committed without success`);
          } catch (error) {
            failures.push(`${toBase58(hash)}: ${errorMessage(error)}`);
          }
        }),
    );
  }
  const entry = run.manifest.transactions.at(-1)!;
  entry.status = failures.length === 0 ? "confirmed" : "unknown";
  if (failures.length) entry.error = failures.slice(0, 5).join("; ");
  await saveRun(run);
  if (failures.length)
    throw new Error(
      `${failures.length} crowd funding transactions did not confirm. Evidence: ${evidence}. Rerun setup after inspecting them.`,
    );
}

async function verify(
  client: Client,
  persona: Persona,
  factory: ContractAddress,
  demoDrop: ContractAddress,
) {
  // Read a snapshot that includes every confirmed setup write.
  const tip = (await client.getChainTip()).blockHeight;
  const options = {
    client,
    caller: persona.account.address,
    minStateBlockHeight: tip,
  };
  const [count, first, remaining] = await Promise.all([
    NftDropFactory.v0_1.dropCount.view({ ...options, address: factory }),
    NftDropFactory.v0_1.dropAt.view({
      ...options,
      address: factory,
      args: { index: 0n },
    }),
    NftDrop.v0_1.remaining.view({ ...options, address: demoDrop }),
  ]);
  if (
    count.value !== 1n ||
    toBase58(first.value) !== toBase58(demoDrop) ||
    remaining.value !== DEMO_DROP.supply
  )
    throw new Error(
      "Setup verification failed: the factory or demo drop is not as expected.",
    );
}

async function writeEnvironment(
  output: string,
  values: Record<string, string>,
) {
  await mkdir(dirname(resolve(output)), { recursive: true });
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const lines = Object.entries(values).map(
      ([key, value]) => `${key}=${value}`,
    );
    await writeFile(temporary, lines.join("\n") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    // Publish only after verification, keeping the previous environment on failure.
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Tests import setup without contacting a node; only direct invocation runs it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  setup().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
