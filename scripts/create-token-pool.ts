import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  PrivateKeySigner,
  addressFromHex,
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  devnet,
  fixedBytes,
  fromHex0x,
  hashContract,
  toHex0x,
} from "@groundhogchain/client";
import { DefaultWallet, ERC20 } from "@groundhogchain/client/contracts";
import {
  ContractType,
  HOG_ADDRESS,
  gasAmount,
  type Contract,
  type Invocation,
} from "@groundhogchain/protocol";

// Reuse the generated bindings for this repository's two factory contracts.
import { SwapFactory } from "../apps/swap/src/contracts/generated/swap-factory.ts";
import { StandardTokenFactory } from "../apps/token-launchpad/src/contracts/generated/standard-token-factory.ts";

const help = `Create two tokens and their AMM pool in one DefaultWallet batch.

Usage (after npm ci):
  npm run create-token-pool -- --token-factory 0x... --swap-factory 0x... \\
    --token-artifact /path/to/standard-token.json \\
    --pool-token-artifact /path/to/pool-token.json

Required flags:
  --token-factory        Initialized standard token factory (32-byte hex)
  --swap-factory         Initialized swap factory (32-byte hex)
  --token-artifact       Launchpad's contract-artifacts/<hash>.json
  --pool-token-artifact  Swap app's contract-artifacts/<hash>.json

Optional:
  --rpc-url  Defaults to public Devnet. For local factories, use
             http://127.0.0.1:9545. Both factories must be on this network.
  --help     Show this usage information.

Artifact paths are resolved from npm's project directory; absolute paths work
from any directory, including when running npm with --prefix.

The demo sends three transactions: an airdrop, a funding batch, and a creation
batch. The wallet key is not saved. The pool starts without liquidity.`;

const callGasLimit = gasAmount(10_000_000n);
const walletGasLimit = gasAmount(50_000_000n);
const decimals = 6n;
const initialSupply = 1_000_000n * 10n ** decimals;
const tokenReserveBuffer = 1_000_000n; // HOG for balance storage and headroom.

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      "rpc-url": { type: "string" },
      "token-factory": { type: "string" },
      "swap-factory": { type: "string" },
      "token-artifact": { type: "string" },
      "pool-token-artifact": { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (args.help) {
    console.log(help);
    return;
  }
  const tokenFactory = addressFromHex(
    requiredArg(args["token-factory"], "token-factory"),
  );
  const swapFactory = addressFromHex(
    requiredArg(args["swap-factory"], "swap-factory"),
  );
  const tokenArtifactPath = requiredArg(
    args["token-artifact"],
    "token-artifact",
  );
  const poolArtifactPath = requiredArg(
    args["pool-token-artifact"],
    "pool-token-artifact",
  );
  const rpcUrl = args["rpc-url"];
  const client = await createGroundhogClient({
    cluster: devnet(rpcUrl ? { rpcUrl } : {}),
  });
  console.log("RPC:", client.cluster.rpcUrl);

  // 1. Create a fresh wallet and request test HOG.
  // Pubkey accounts already use the native DefaultWallet; no deployment is needed.
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  console.log("Default wallet:", toHex0x(account.address));
  const airdrop = await wallet.requestAirdrop();
  assert.equal(airdrop.status.result, "ok", "Airdrop failed");
  console.log("Airdrop:", toHex0x(airdrop.txHash));

  // 2. Read funding requirements and predict both token addresses.
  // These are read-only calls. Prediction lets us fund tokens before deployment
  // and build the pool call before either token exists.
  const [{ value: config }, { value: poolFunding }, tokenA, tokenB] =
    await Promise.all([
      StandardTokenFactory.config.view({ client, contract: tokenFactory }),
      SwapFactory.poolFunding.view({ client, contract: swapFactory }),
      predictToken("Batch Token A", "BATCHA"),
      predictToken("Batch Token B", "BATCHB"),
    ]);
  const tokens = [tokenA, tokenB];
  assert(
    bytesEqual(config.native_token, HOG_ADDRESS),
    "Factory must use native HOG",
  );
  assert(
    config.required_token_funding > 0n &&
      poolFunding.min > 0n &&
      poolFunding.recommended >= poolFunding.min,
    "Invalid factory funding policy",
  );

  // Factory deployments need bytecode attached to the creation transaction.
  // Both new tokens share one implementation; the pool uses a separate LP token.
  const contracts = await Promise.all([
    loadDeploymentArtifact(tokenArtifactPath, toHex0x(config.token_code_hash)),
    loadDeploymentArtifact(poolArtifactPath),
  ]);
  const tokenFunding = config.required_token_funding + tokenReserveBuffer;
  // A pool has three contracts: its LP token, handler, and driver.
  const poolFundingTotal = poolFunding.recommended * 3n;
  const creationFees = config.creation_fee * 2n;
  const requiredFunding = tokenFunding * 2n + poolFundingTotal + creationFees;
  const { value: balance } = await ERC20.getBalanceOf.view({
    client,
    contract: HOG_ADDRESS,
    args: { addr: account.address },
  });
  assert(
    balance > requiredFunding,
    `Wallet has ${balance} HOG base units; needs ${requiredFunding} plus execution costs`,
  );

  // 3. Commit the funding batch before the token factory checks these balances.
  // The pool factory pulls HOG using an allowance when it creates the pool.
  const funding = [
    ...tokens.map(({ address }) =>
      ERC20.transfer.invocation(HOG_ADDRESS, callGasLimit, {
        receiver: address,
        amount: tokenFunding,
      }),
    ),
    ERC20.adjustAllowance.invocation(HOG_ADDRESS, callGasLimit, {
      spender: swapFactory,
      diff: poolFundingTotal,
    }),
  ];
  if (creationFees > 0n) {
    funding.push(
      ERC20.adjustAllowance.invocation(HOG_ADDRESS, callGasLimit, {
        spender: tokenFactory,
        diff: creationFees,
      }),
    );
  }
  await sendBatch("Funding and allowances", funding);

  // 4. One atomic batch: create token A, create token B, then create their pool.
  // Calls run in order. Either all three creations commit, or all three revert.
  const creations = [
    ...tokens.map(({ nonce, name, symbol }) =>
      StandardTokenFactory.createToken.invocation(tokenFactory, callGasLimit, {
        nonce,
        name,
        symbol,
        decimals,
        initialSupply,
        administrator: account.address,
        initialHolder: account.address,
      }),
    ),
    SwapFactory.createPair.invocation(swapFactory, callGasLimit, {
      tokenA: tokenA.address,
      tokenB: tokenB.address,
      funding: poolFunding.recommended,
    }),
  ];
  const receipt = await sendBatch(
    "Token and pool creation",
    creations,
    contracts,
  );

  // 5. DefaultWallet returns one result per call, in the same order.
  const [resultA, resultB, resultPool] = receipt.value;
  assert(resultA && resultB && resultPool, "Missing creation results");
  const createdA = StandardTokenFactory.createToken.decodeReturn(resultA);
  const createdB = StandardTokenFactory.createToken.decodeReturn(resultB);
  assert(bytesEqual(createdA, tokenA.address), "Token A prediction mismatch");
  assert(bytesEqual(createdB, tokenB.address), "Token B prediction mismatch");
  const pool = SwapFactory.createPair.decodeReturn(resultPool);
  console.log({
    transaction: toHex0x(receipt.txHash),
    block: receipt.height.toString(),
    tokenA: toHex0x(tokenA.address),
    tokenB: toHex0x(tokenB.address),
    pool: {
      handler: toHex0x(pool.handler),
      driver: toHex0x(pool.driver),
      liquidityToken: toHex0x(pool.liquidity_token),
    },
  });

  async function predictToken(name: string, symbol: string) {
    const nonce = fixedBytes(randomBytes(32), 32);
    const { value: address } = await StandardTokenFactory.predictToken.view({
      client,
      contract: tokenFactory,
      args: { creator: account.address, nonce },
    });
    return { name, symbol, nonce, address };
  }

  async function sendBatch(
    label: string,
    invocations: Invocation[],
    contractsToDeploy: Contract[] = [],
  ) {
    // wallet.execute() wraps one call. For a batch, build the DefaultWallet root
    // explicitly and submit it with sendInvocation() to avoid double wrapping.
    const calls = invocations.map((call) => ({
      target: call.invoked_address,
      entrypoint: fixedBytes(call.entrypoint, 8),
      gas_limit: call.gas_limit,
      calldata: call.calldata,
    }));
    const txHash = await wallet.sendInvocation({
      invocation: DefaultWallet.execute.invocation(
        account.address,
        walletGasLimit,
        { calls },
      ),
      contractsToDeploy,
    });
    console.log(`${label} submitted:`, toHex0x(txHash));
    // Waiting for inclusion alone isn't enough: decoding also checks success.
    const receipt = DefaultWallet.execute.decodeReceipt(
      await wallet.waitForTransactionReceipt(txHash),
    );
    assert.equal(receipt.value.length, calls.length, "Unexpected result count");
    return receipt;
  }
}

// Read the JSON format produced by the apps' setup scripts and verify its hash.
async function loadDeploymentArtifact(
  path: string,
  expectedHash?: string,
): Promise<Contract> {
  const artifact: unknown = JSON.parse(await readFile(path, "utf8"));
  assert(
    artifact &&
      typeof artifact === "object" &&
      "contractType" in artifact &&
      artifact.contractType === "rv32" &&
      "data" in artifact &&
      typeof artifact.data === "string" &&
      /^0x(?:[0-9a-fA-F]{2})+$/.test(artifact.data) &&
      "hash" in artifact &&
      typeof artifact.hash === "string",
    `Invalid RV32 artifact: ${path}`,
  );
  const contract: Contract = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: fromHex0x(artifact.data) },
  };
  const hash = toHex0x(hashContract(contract));
  assert.equal(hash, artifact.hash, `Artifact hash mismatch: ${path}`);
  if (expectedHash) {
    assert.equal(hash, expectedHash, "Artifact does not match token factory");
  }
  return contract;
}

function requiredArg(value: string | undefined, name: string): string {
  assert(value, `Provide --${name} (see --help)`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
