import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  addressFromBase58,
  bytesEqual,
  createPubkeyAccount,
  createThruputClient,
  createWalletClient,
  defineCluster,
  Ed25519Signer,
  fixedBytes,
  fromHex0x,
  hashContract,
  hashSignedTransaction,
  HttpTransport,
  parseUnits,
  serializeSignedTransaction,
  toBase58,
  toHex0x,
  type Transaction,
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "@thruputchain/client/contracts";
import { prepareContractDeployment } from "@thruputchain/client/wallet";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
  type Contract,
  type Invocation,
} from "@thruputchain/protocol";
import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../../token-launchpad/src/contracts/generated/standard-token-factory";
import { SwapFactory } from "../../swap/src/contracts/generated/swap-factory";
import { SwapRouter } from "../../swap/src/contracts/generated/swap-router";
import {
  SwapDriver,
  batch_driver,
} from "../../swap/src/contracts/generated/swap-driver";
import { SwapHandler } from "../../swap/src/contracts/generated/swap-handler";
import {
  waitForView,
  verifySwapRelationship,
} from "../../../scripts/seed/seed-preflight";
import { assertLiquidityMint } from "../../../scripts/seed/seed-liquidity";
import { ASSETS } from "./assets";
import { storageFunding } from "./funding";
import { address, parseTokens, type Token } from "../shared/config";
import { Airdrop } from "../src/contracts/generated/airdrop";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const mode = process.argv[2];
if (mode !== "local" && mode !== "devnet")
  throw new Error("Choose local or devnet.");
const output = resolve(
  root,
  process.env.AIRDROP_ENV_PATH || `apps/airdrop/.env.${mode}`,
);
const run = resolve(
  root,
  process.env.AIRDROP_SETUP_DIR || `apps/airdrop/.local/${mode}`,
);
try {
  await lstat(output);
  throw new Error(
    "Airdrop environment already exists. Select a new AIRDROP_ENV_PATH.",
  );
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  )
    throw error;
}
const jsonFile = async (path: string) =>
  JSON.parse(await readFile(resolve(root, path), "utf8")) as unknown;
const custom = process.env.AIRDROP_TOKENS_FILE
  ? parseTokens(await jsonFile(process.env.AIRDROP_TOKENS_FILE))
  : null;
const list = process.env.AIRDROP_ADDRESSES_FILE
  ? await jsonFile(process.env.AIRDROP_ADDRESSES_FILE)
  : [];
if (
  !Array.isArray(list) ||
  list.length > 256 ||
  list.some((v) => typeof v !== "string")
)
  throw new Error("Use an array of at most 256 eligible addresses.");
const addresses = list.map((v) => address(v as string));
if (new Set(addresses).size !== addresses.length)
  throw new Error("Eligible addresses must be unique.");
const packs = BigInt(process.env.AIRDROP_PACKS || "1000");
if (packs < 1n || packs > 10000n)
  throw new Error("AIRDROP_PACKS must be between 1 and 10000.");
const environment = async (path: string) =>
  parseEnv(await readFile(resolve(root, path), "utf8"));
const launch = custom
  ? null
  : await environment(
      process.env.LAUNCHPAD_APP_ENV || `apps/token-launchpad/.env.${mode}`,
    );
const swap = custom
  ? null
  : await environment(process.env.SWAP_APP_ENV || `apps/swap/.env.${mode}`);
const rpcUrl =
  process.env.THRUPUT_RPC_URL ||
  launch?.VITE_THRUPUT_RPC_URL ||
  "http://127.0.0.1:9545";
const url = new URL(rpcUrl);
if (
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  (mode === "local"
    ? url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    : url.protocol !== "https:")
)
  throw new Error("Invalid RPC URL for setup mode.");
const client = await createThruputClient({
  cluster: defineCluster({ name: mode, rpcUrl, capabilities: ["airdrop"] }),
  transport: new HttpTransport(rpcUrl, {
    timeoutMs: 10000,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  }),
});
const network = toBase58(client.network.networkHash);
if (
  process.env.THRUPUT_NETWORK_ID &&
  process.env.THRUPUT_NETWORK_ID !== network
)
  throw new Error("Network ID mismatch.");
if (
  launch &&
  swap &&
  (launch.VITE_THRUPUT_NETWORK_ID !== network ||
    swap.VITE_THRUPUT_NETWORK_ID !== network)
)
  throw new Error("Launchpad and Swap must use this network.");
const anchor = await client.getBlockByHeight({ blockHeight: 1n });
if (!anchor) throw new Error("Chain checkpoint is unavailable.");
const secret =
  mode === "local"
    ? toHex0x(randomBytes(32))
    : process.env.AIRDROP_DEPLOYER_PRIVATE_KEY;
if (!secret || !/^0x[0-9a-fA-F]{64}$/.test(secret))
  throw new Error(
    "Set AIRDROP_DEPLOYER_PRIVATE_KEY to a funded devnet deployer.",
  );
// Custom-token setup uses a signer that already owns the selected token budget.
const signingKey = process.env.AIRDROP_DEPLOYER_PRIVATE_KEY || secret;
if (!/^0x[0-9a-fA-F]{64}$/.test(signingKey))
  throw new Error("Invalid deployer key.");
const account = createPubkeyAccount({
  signer: new Ed25519Signer(fromHex0x(signingKey)),
});
const wallet = createWalletClient({ client, account });
await mkdir(dirname(run), { recursive: true, mode: 0o700 });
await mkdir(run, { mode: 0o700 });
await writeFile(
  resolve(run, "deployer.env"),
  `AIRDROP_DEPLOYER_PRIVATE_KEY=${signingKey}\n`,
  { flag: "wx", mode: 0o600, flush: true },
);
console.log(`Airdrop deployer: ${toBase58(account.address)}`);
const GAS = gasAmount(20_000_000n);
let height = 0n,
  sequence = 0;
async function fundLocal(minimum = 100_000_000n) {
  if (mode !== "local") return;
  let balance = (await wallet.getBalance()).rawBalance;
  while (balance < minimum) {
    const funded = await wallet.requestAirdrop();
    if (funded.attemptStatus !== "succeeded")
      throw new Error(
        "Native funding is unresolved. Inspect the original request.",
      );
    const next = (await wallet.getBalance()).rawBalance;
    if (next <= balance)
      throw new Error(
        "Native funding is not visible yet. Inspect the original request before continuing.",
      );
    balance = next;
  }
}
async function submit(name: string, prepare: () => Promise<Transaction>) {
  const [info, checkpoint] = await Promise.all([
    client.getNetworkInfo(),
    client.getBlockByHeight({ blockHeight: 1n }),
  ]);
  if (
    toBase58(info.networkHash) !== network ||
    !checkpoint ||
    !bytesEqual(checkpoint.blockHash, anchor!.blockHash)
  )
    throw new Error("Network changed during provisioning.");
  await fundLocal();
  const signed = await wallet.signTransaction(await prepare());
  const hash = hashSignedTransaction(signed),
    bytes = serializeSignedTransaction(signed);
  const path = resolve(run, `${String(++sequence).padStart(3, "0")}-${name}`);
  await writeFile(
    `${path}.json`,
    JSON.stringify({ network, hash: toBase58(hash), signed: toHex0x(bytes) }),
    { flag: "wx", mode: 0o600, flush: true },
  );
  console.log(`${name}: ${toBase58(hash)}`);
  const sent = await wallet.sendTransaction({ signedTransaction: bytes });
  if (!bytesEqual(sent.transactionHash, hash))
    throw new Error("Submission hash mismatch. Inspect saved evidence.");
  const receipt = await wallet.waitForTransactionReceipt(hash, {
    timeoutMs: 60000,
  });
  if (
    !bytesEqual(receipt.transactionHash, hash) ||
    !("result" in receipt.execution) ||
    receipt.execution.result !== "return"
  )
    throw new Error("Transaction failed. Inspect saved evidence.");
  await writeFile(
    `${path}.receipt.json`,
    JSON.stringify(receipt, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    ),
    { flag: "wx", mode: 0o600 },
  );
  height = receipt.blockHeight;
  return receipt;
}
const execute = (
  name: string,
  invocation: Invocation,
  contractsToDeploy: Contract[] = [],
) =>
  submit(name, () =>
    wallet.prepareExecution({ invocation, contractsToDeploy, gasLimit: GAS }),
  );
async function artifact(directory: string, hash: string): Promise<Contract> {
  const value = JSON.parse(
    await readFile(
      resolve(root, directory, "contract-artifacts", `${hash}.json`),
      "utf8",
    ),
  );
  const contract: Contract = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: fromHex0x(value.data) },
  };
  if (
    value.contractType !== "rv32" ||
    value.hash !== hash ||
    toBase58(hashContract(contract)) !== hash
  )
    throw new Error("Artifact hash mismatch.");
  return contract;
}
const tokens: Token[] = custom || [];
if (launch && swap) {
  const factory = addressFromBase58(
    launch.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!,
  );
  const poolFactory = addressFromBase58(swap.VITE_SWAP_FACTORY_ADDRESS!),
    router = addressFromBase58(swap.VITE_SWAP_ROUTER_ADDRESS!);
  await verifySwapRelationship(client, poolFactory, router);
  const policy = (
    await StandardTokenFactory.v0_1.config.view({ client, address: factory })
  ).value;
  if (
    toBase58(policy.token_code_hash) !== launch.VITE_STANDARD_TOKEN_HASH ||
    !bytesEqual(policy.native_token, NATIVE_TOKEN_ADDRESS) ||
    policy.creation_fee !== 0n ||
    policy.fee_recipient !== null ||
    policy.required_token_funding <= 0n
  )
    throw new Error("Unsupported token factory configuration.");
  const funding = (
    await SwapFactory.v0_1.poolFunding.view({ client, address: poolFactory })
  ).value;
  if (funding.min <= 0n || funding.recommended < funding.min)
    throw new Error("Invalid pool funding policy.");
  const tokenCode = await artifact(
    process.env.LAUNCHPAD_APP_PUBLIC_DIR || "apps/token-launchpad/public",
    launch.VITE_STANDARD_TOKEN_HASH!,
  );
  const poolCode = await artifact(
    process.env.SWAP_APP_PUBLIC_DIR || "apps/swap/public",
    swap.VITE_POOL_TOKEN_HASH!,
  );
  for (const asset of ASSETS) {
    const nonce = fixedBytes(randomBytes(32), 32);
    const token = (
      await StandardTokenFactory.v0_1.predictToken.view({
        client,
        address: factory,
        args: { creator: account.address, nonce },
      })
    ).value;
    const claimAmount = parseUnits(asset.amount, asset.decimals);
    const supply = claimAmount * (asset.symbol === "tUSDC" ? 20000n : 12000n);
    await execute(
      `fund-${asset.symbol}`,
      ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
        receiver: token,
        amount: policy.required_token_funding + 10000000n,
      }),
    );
    const receipt = await execute(
      `create-${asset.symbol}`,
      StandardTokenFactory.v0_1.createToken.invocation(factory, GAS, {
        nonce,
        administrator: account.address,
        initialHolder: account.address,
        initialSupply: supply,
        name: asset.name,
        symbol: asset.symbol,
        decimals: BigInt(asset.decimals),
      }),
      [tokenCode],
    );
    const created =
      standard_token_factory_if.v0_1.events.TokenCreated.singleFromReceipt(
        receipt,
        { address: factory },
      );
    if (
      !bytesEqual(created.topics.token, token) ||
      !bytesEqual(created.topics.creator, account.address) ||
      created.fields.initial_supply !== supply
    )
      throw new Error("Token creation evidence mismatch.");
    tokens.push({
      address: toBase58(token),
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      claimAmount: String(claimAmount),
    });
    await writeFile(
      resolve(run, "tokens.json"),
      JSON.stringify(tokens, null, 2),
      { mode: 0o600 },
    );
  }
  const pools = [];
  for (const token of tokens.slice(1)) {
    const ordered = [tokens[0]!, token].sort((a, b) =>
      Buffer.compare(
        addressFromBase58(a.address),
        addressFromBase58(b.address),
      ),
    );
    const tokenA = addressFromBase58(ordered[0]!.address),
      tokenB = addressFromBase58(ordered[1]!.address);
    const amounts: [bigint, bigint] = [
      BigInt(ordered[0]!.claimAmount) * 1000n,
      BigInt(ordered[1]!.claimAmount) * 1000n,
    ];
    await execute(
      `approve-${token.symbol}-funding`,
      ERC20.v0_1.adjustAllowance.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
        spender: poolFactory,
        difference: funding.recommended * 3n,
      }),
    );
    await execute(
      `pair-${token.symbol}`,
      SwapFactory.v0_1.createPair.invocation(poolFactory, GAS, {
        tokenA,
        tokenB,
        funding: funding.recommended,
      }),
      [poolCode],
    );
    const pool = (
      await waitForView(() =>
        SwapFactory.v0_1.poolAddresses.view({
          client,
          address: poolFactory,
          args: { tokenA, tokenB },
          minStateBlockHeight: height,
        }),
      )
    ).value;
    for (const [tokenAddress, amount] of [
      [tokenA, amounts[0]],
      [tokenB, amounts[1]],
    ] as const)
      await execute(
        `approve-${token.symbol}`,
        ERC20.v0_1.adjustAllowance.invocation(tokenAddress, GAS, {
          spender: pool.handler,
          difference: amount,
        }),
      );
    const queued = await execute(
      `liquidity-${token.symbol}`,
      SwapRouter.v0_1.addLiquidity.invocation(router, GAS, {
        tokenA,
        tokenB,
        amountsDesired: amounts,
        amountsMin: amounts,
        recipient: account.address,
      }),
    );
    const accepted = batch_driver.v0_1.events.RequestAccepted.singleFromReceipt(
      queued,
      { address: pool.driver },
    );
    const receipt = await execute(
      `process-${token.symbol}`,
      SwapDriver.v0_1.processRequests.invocation(pool.driver, GAS),
    );
    assertLiquidityMint(
      receipt,
      pool.handler,
      accepted.topics.request_id,
      account.address,
      account.address,
    );
    const state = (
      await waitForView(() =>
        SwapHandler.v0_1.poolState.view({
          client,
          address: pool.handler,
          minStateBlockHeight: height,
        }),
      )
    ).value;
    if (state.reserves.some((value, index) => value !== amounts[index]))
      throw new Error("Pool reserves mismatch.");
    pools.push({
      token: token.address,
      quote: tokens[0]!.address,
      handler: toBase58(pool.handler),
      driver: toBase58(pool.driver),
    });
    await writeFile(
      resolve(run, "pools.json"),
      JSON.stringify(pools, null, 2),
      { mode: 0o600 },
    );
  }
}
// Validate the supplied metadata and budget before deploying the claim contract.
for (const token of tokens) {
  const options = {
    client,
    address: addressFromBase58(token.address),
    minStateBlockHeight: height,
  };
  const [symbol, decimals, balance] = await Promise.all([
    waitForView(() => ERC20Metadata.v0_1.symbol.view(options)),
    waitForView(() => ERC20Metadata.v0_1.decimals.view(options)),
    waitForView(() =>
      ERC20.v0_1.getBalanceOf.view({
        ...options,
        args: { addr: account.address },
      }),
    ),
  ]);
  if (
    symbol.value !== token.symbol ||
    Number(decimals.value) !== token.decimals ||
    balance.value < BigInt(token.claimAmount) * packs
  )
    throw new Error(
      `Token metadata or deployer balance mismatch for ${token.symbol}.`,
    );
}
const code = await readFile(resolve(root, "target/thruput/airdrop.rv32a"));
const execution = (await client.getChainConfig()).execution;
if (!execution)
  throw new Error("RPC must expose execution storage costs for provisioning.");
const funding = storageFunding(
  execution.storageCosts,
  packs,
  addresses.length,
  code.length,
);
await fundLocal(
  funding.airdrop + funding.token * BigInt(tokens.length) + 100_000_000n,
);
const deployment = prepareContractDeployment({
  deployer: account.address,
  contract: code,
});
await submit("deploy-airdrop", () =>
  wallet.prepareDeployment(deployment, {
    gasLimit: GAS,
    amount: funding.airdrop,
    initializer: Airdrop.v0_1.initialize.invocation(deployment.address, GAS, {
      rewards: tokens.map((t) => ({
        token: addressFromBase58(t.address),
        amount: BigInt(t.claimAmount),
      })),
      addresses: addresses.map(addressFromBase58),
    }),
  }),
);
for (const token of tokens) {
  const tokenAddress = addressFromBase58(token.address);
  await execute(
    `storage-${token.symbol}`,
    ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
      receiver: tokenAddress,
      amount: funding.token,
    }),
  );
  await execute(
    `distribute-${token.symbol}`,
    ERC20.v0_1.transfer.invocation(tokenAddress, GAS, {
      receiver: deployment.address,
      amount: BigInt(token.claimAmount) * packs,
    }),
  );
}
const configuration = (
  await waitForView(() =>
    Airdrop.v0_1.config.view({
      client,
      address: deployment.address,
      minStateBlockHeight: height,
    }),
  )
).value;
if (
  configuration.restricted !== addresses.length > 0 ||
  configuration.rewards.length !== tokens.length
)
  throw new Error("Airdrop configuration mismatch.");
const config = {
  THRUPUT_RPC_URL: rpcUrl,
  THRUPUT_NETWORK_ID: network,
  AIRDROP_ANCHOR_HEIGHT: "1",
  AIRDROP_ANCHOR_HASH: toBase58(anchor.blockHash),
  AIRDROP_ADDRESS: toBase58(deployment.address),
  AIRDROP_TOKENS: JSON.stringify(tokens).replaceAll("'", "\\u0027"),
  SWAP_APP_URL:
    mode === "local"
      ? "http://127.0.0.1:5174/"
      : "https://examples.thruput.network/swap/",
};
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  Object.entries(config)
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n") + "\n",
  { flag: "wx", mode: 0o600, flush: true },
);
console.log(
  `Airdrop ready: ${toBase58(deployment.address)}. Configuration: ${output}`,
);
