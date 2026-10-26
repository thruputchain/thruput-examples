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
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "@thruputchain/client/contracts";
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
import { type Token } from "../shared/config";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const mode = process.argv[2];
if (mode !== "local" && mode !== "devnet")
  throw new Error("Choose local or devnet.");
const suffix = mode === "local" ? "local" : "devnet";
const envFile = resolve(
  root,
  process.env.FAUCET_ENV_PATH || `apps/token-faucet/.env.${suffix}`,
);
const run = resolve(
  root,
  process.env.FAUCET_SETUP_DIR || `apps/token-faucet/.local/${suffix}`,
);
try {
  await lstat(envFile);
  throw new Error(
    "Faucet environment already exists. Choose a new FAUCET_ENV_PATH for fresh assets.",
  );
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  )
    throw error;
}
await mkdir(dirname(run), { recursive: true, mode: 0o700 });
// Exclusive directory is also a write-once provisioning journal. A stopped run
// requires inspection; running setup again must not create replacement assets.
await mkdir(run, { mode: 0o700 });
const env = async (path: string) =>
  parseEnv(await readFile(resolve(root, path), "utf8"));
const launch = await env(
  process.env.LAUNCHPAD_APP_ENV || `apps/token-launchpad/.env.${suffix}`,
);
const swap = await env(process.env.SWAP_APP_ENV || `apps/swap/.env.${suffix}`);
const rpcUrl = process.env.THRUPUT_RPC_URL || launch.VITE_THRUPUT_RPC_URL!;
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
  cluster: defineCluster({ name: suffix, rpcUrl, capabilities: ["airdrop"] }),
  transport: new HttpTransport(rpcUrl, {
    timeoutMs: 10_000,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  }),
});
const network = toBase58(client.network.networkHash);
if (
  launch.VITE_THRUPUT_NETWORK_ID !== network ||
  swap.VITE_THRUPUT_NETWORK_ID !== network
)
  throw new Error("Launchpad and Swap must match this network.");
const anchor = await client.getBlockByHeight({ blockHeight: 1n });
if (!anchor) throw new Error("Chain checkpoint is not available.");
const factory = addressFromBase58(launch.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!);
const poolFactory = addressFromBase58(swap.VITE_SWAP_FACTORY_ADDRESS!);
const router = addressFromBase58(swap.VITE_SWAP_ROUTER_ADDRESS!);
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
const poolFunding = (
  await SwapFactory.v0_1.poolFunding.view({ client, address: poolFactory })
).value;
if (poolFunding.min <= 0n || poolFunding.recommended < poolFunding.min)
  throw new Error("Invalid pool funding policy.");
const funding = poolFunding.recommended;
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
const tokenCode = await artifact(
  process.env.LAUNCHPAD_APP_PUBLIC_DIR || "apps/token-launchpad/public",
  launch.VITE_STANDARD_TOKEN_HASH!,
);
const poolCode = await artifact(
  process.env.SWAP_APP_PUBLIC_DIR || "apps/swap/public",
  swap.VITE_POOL_TOKEN_HASH!,
);
const secret =
  mode === "local"
    ? toHex0x(randomBytes(32))
    : process.env.FAUCET_SIGNING_PRIVATE_KEY;
if (!secret || !/^0x[0-9a-fA-F]{64}$/.test(secret))
  throw new Error("Set FAUCET_SIGNING_PRIVATE_KEY to a funded devnet signer.");
const account = createPubkeyAccount({
  signer: new Ed25519Signer(fromHex0x(secret)),
});
const wallet = createWalletClient({ client, account });
await writeFile(
  resolve(run, "signer.env"),
  `FAUCET_SIGNING_PRIVATE_KEY=${secret}\nFAUCET_ADDRESS=${toBase58(account.address)}\n`,
  { flag: "wx", mode: 0o600, flush: true },
);
console.log(
  `Provisioning six test tokens. Faucet: ${toBase58(account.address)}`,
);
const GAS = gasAmount(10_000_000n);
let height = 0n;
let sequence = 0;
async function execute(
  name: string,
  invocation: Invocation,
  contractsToDeploy: Contract[] = [],
) {
  const info = await client.getNetworkInfo();
  const current = await client.getBlockByHeight({ blockHeight: 1n });
  if (
    toBase58(info.networkHash) !== network ||
    !current ||
    !bytesEqual(current.blockHash, anchor!.blockHash)
  )
    throw new Error("Network changed during provisioning.");
  if (
    mode === "local" &&
    (await wallet.getBalance()).rawBalance < 100_000_000n + funding * 3n
  ) {
    const airdrop = await wallet.requestAirdrop();
    if (airdrop.attemptStatus !== "succeeded")
      throw new Error(
        "Local native funding is unresolved. Inspect the airdrop before continuing.",
      );
  }
  const signed = await wallet.signTransaction(
    await wallet.prepareExecution({
      invocation,
      contractsToDeploy,
      gasLimit: GAS,
    }),
  );
  const hash = hashSignedTransaction(signed);
  const bytes = serializeSignedTransaction(signed);
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
    timeoutMs: 60_000,
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
const tokens: Token[] = [];
for (const asset of ASSETS) {
  const nonce = fixedBytes(randomBytes(32), 32);
  const address = (
    await StandardTokenFactory.v0_1.predictToken.view({
      client,
      address: factory,
      args: { creator: account.address, nonce },
    })
  ).value;
  const claimAmount = parseUnits(asset.amount, asset.decimals);
  const supply = claimAmount * (asset.symbol === "tUSDC" ? 20_000n : 12_000n);
  await execute(
    `fund-${asset.symbol}`,
    ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
      receiver: address,
      amount: policy.required_token_funding + 10_000_000n,
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
    !bytesEqual(created.topics.token, address) ||
    !bytesEqual(created.topics.creator, account.address) ||
    !bytesEqual(created.fields.administrator, account.address) ||
    !bytesEqual(created.fields.initial_holder, account.address) ||
    created.fields.initial_supply !== supply
  )
    throw new Error("Token creation evidence mismatch.");
  const options = { client, address, minStateBlockHeight: height };
  const symbol = await waitForView(() =>
    ERC20Metadata.v0_1.symbol.view(options),
  );
  const balance = await waitForView(() =>
    ERC20.v0_1.getBalanceOf.view({
      ...options,
      args: { addr: account.address },
    }),
  );
  if (symbol.value !== asset.symbol || balance.value !== supply)
    throw new Error("Token state mismatch.");
  tokens.push({
    address: toBase58(address),
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
  const quote = tokens[0]!;
  // Router amount arrays use the pool's canonical address order.
  const ordered = [quote, token].sort((a, b) =>
    Buffer.compare(addressFromBase58(a.address), addressFromBase58(b.address)),
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
      difference: funding * 3n,
    }),
  );
  await execute(
    `pair-${token.symbol}`,
    SwapFactory.v0_1.createPair.invocation(poolFactory, GAS, {
      tokenA,
      tokenB,
      funding,
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
  for (const [address, amount] of [
    [tokenA, amounts[0]],
    [tokenB, amounts[1]],
  ] as const)
    await execute(
      `approve-${token.symbol}`,
      ERC20.v0_1.adjustAllowance.invocation(address, GAS, {
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
    quote: quote.address,
    handler: toBase58(pool.handler),
    driver: toBase58(pool.driver),
    liquidityToken: toBase58(pool.liquidity_token),
  });
  await writeFile(resolve(run, "pools.json"), JSON.stringify(pools, null, 2), {
    mode: 0o600,
  });
}
const config = {
  THRUPUT_RPC_URL: rpcUrl,
  THRUPUT_NETWORK_ID: network,
  FAUCET_ANCHOR_HEIGHT: "1",
  FAUCET_ANCHOR_HASH: toBase58(anchor.blockHash),
  FAUCET_ADDRESS: toBase58(account.address),
  FAUCET_SIGNING_PRIVATE_KEY: secret,
  FAUCET_IP_SALT: randomBytes(32).toString("hex"),
  ...(mode === "devnet"
    ? { FAUCET_PROXY_SECRET: randomBytes(32).toString("hex") }
    : {}),
  FAUCET_DB_PATH: resolve(run, "claims.sqlite"),
  FAUCET_TOKENS: JSON.stringify(tokens),
  SWAP_APP_URL:
    mode === "local"
      ? "http://127.0.0.1:5174/"
      : "https://examples.thruput.network/swap/",
};
await mkdir(dirname(envFile), { recursive: true });
await writeFile(
  envFile,
  Object.entries(config)
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n") + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(`Provisioned six tokens and five pools. Config: ${envFile}`);
