// Explicit live check: npm run test:swap (generate Swap bindings first).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  createPubkeyAccount,
  createWalletClient,
  Ed25519Signer,
  fromHex0x,
  hashContract,
  prepareContractDeployment,
  toBase58,
  type ContractDeployment,
} from "@thruputchain/client";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
  type Contract,
  type Invocation,
} from "@thruputchain/protocol";
import { setup } from "../../apps/swap/scripts/index";
import { ERC20 } from "../../apps/swap/src/contracts/generated/erc20";
import {
  SwapFactory,
  swap_if,
} from "../../apps/swap/src/contracts/generated/swap-factory";
import { SwapRouter } from "../../apps/swap/src/contracts/generated/swap-router";
import { SwapHandler } from "../../apps/swap/src/contracts/generated/swap-handler";
import {
  SwapDriver,
  batch_driver,
} from "../../apps/swap/src/contracts/generated/swap-driver";
import { CRANK_FRAME_GAS } from "../../apps/swap/src/contracts/driver-target";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-swap-"));
const groups = new OwnedProcessGroups();
let interrupted = false;
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void groups.stopAll().catch(console.error);
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 240_000);

try {
  const rpcUrl = await startNode();
  const env = {
    THRUPUT_RPC_URL: rpcUrl,
    SWAP_APP_ENV: join(work, ".env.local"),
    SWAP_APP_PUBLIC_DIR: join(work, "public"),
  };
  const local = await setup(env);
  await checkPool(local, env.SWAP_APP_ENV);
  const devnet = await setup(
    { ...env, SWAP_APP_ENV: join(work, ".env.devnet") },
    "devnet",
  );
  assert.notDeepEqual(local.factory, devnet.factory);
  assert.notDeepEqual(local.router, devnet.router);
  await checkPool(devnet, join(work, ".env.devnet"));
  const before = await readFile(env.SWAP_APP_ENV, "utf8");
  await assert.rejects(() =>
    setup({ ...env, THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)) }),
  );
  assert.equal(await readFile(env.SWAP_APP_ENV, "utf8"), before);
  console.log(`Swap end-to-end checks passed. Evidence: ${work}`);
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await groups.stopAll();
}

async function checkPool(
  { client, factory, router }: Awaited<ReturnType<typeof setup>>,
  output: string,
) {
  const env = parseEnv(await readFile(output, "utf8"));
  assert.equal(
    env.VITE_THRUPUT_NETWORK_ID,
    toBase58(new Uint8Array(32).fill(1)),
  );
  assert.equal(env.VITE_SWAP_FACTORY_ADDRESS, toBase58(factory));
  assert.equal(env.VITE_SWAP_ROUTER_ADDRESS, toBase58(router));
  const asset = JSON.parse(
    await readFile(
      join(
        work,
        "public/contract-artifacts",
        `${env.VITE_POOL_TOKEN_HASH}.json`,
      ),
      "utf8",
    ),
  );
  const contract = {
    contract_type: ContractType.kRv32 as const,
    rv32_contract: { data: fromHex0x(asset.data) },
  };
  assert.equal(toBase58(hashContract(contract)), env.VITE_POOL_TOKEN_HASH);
  const account = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  await wallet.requestAirdrop();
  const gas = gasAmount(10_000_000n);
  let height = 0n;
  async function execute(
    invocation: Invocation,
    contractsToDeploy: Contract[] = [],
  ) {
    assert.ok(!interrupted, "Swap checks interrupted");
    const result = await wallet.executeAndWait(
      {
        invocation,
        gasLimit: gasAmount(invocation.gas_limit + 5_000_000n),
        contractsToDeploy,
      },
      { timeoutMs: 60_000 },
    );
    height = result.receipt.blockHeight;
    return result.receipt;
  }
  const tokens: ContractDeployment[] = [0, 1].map(() =>
    prepareContractDeployment({ deployer: account.address, contract }),
  );
  const [tokenA, tokenB] = tokens.map((token) => token.address) as [
    typeof factory,
    typeof factory,
  ];
  const liquidity = 1_000_000_000n;
  const supply = 10_000_000_000n;

  // Create the first pool before deploying the test tokens, so LP code must be
  // loaded from the public artifact rather than an earlier token deployment.
  await execute(
    ERC20.v0_1.adjustAllowance.invocation(NATIVE_TOKEN_ADDRESS, gas, {
      spender: factory,
      difference: 30_000_000n,
    }),
  );
  const created = await execute(
    SwapFactory.v0_1.createPair.invocation(factory, gas, {
      tokenA,
      tokenB,
      funding: 10_000_000n,
    }),
    [contract],
  );
  const pool = (
    await SwapFactory.v0_1.poolAddresses.view({
      client,
      address: factory,
      args: { tokenA, tokenB },
      minStateBlockHeight: height,
    })
  ).value;
  const event = swap_if.v0_1.events.PoolCreated.singleFromReceipt(created, {
    address: factory,
  });
  assert.equal(event.fields.pair_count, 1n);
  assert.equal(
    (
      await SwapFactory.v0_1.allPairsLength.view({
        client,
        address: factory,
        minStateBlockHeight: height,
      })
    ).value,
    1n,
  );
  assert.deepEqual(
    (
      await SwapFactory.v0_1.getPair.view({
        client,
        address: factory,
        args: { tokenA, tokenB },
        minStateBlockHeight: height,
      })
    ).value,
    pool.handler,
  );

  for (const token of tokens) {
    const deployed = await wallet.deployContractAndWait(
      token,
      {
        gasLimit: gas,
        amount: 10_000_000n,
        initializer: ERC20.v0_1.initialize.invocation(token.address, gas, {
          administrator: account.address,
        }),
      },
      { timeoutMs: 60_000 },
    );
    height = deployed.receipt.blockHeight;
    await execute(
      ERC20.v0_1.mint.invocation(token.address, gas, {
        receiver: account.address,
        amount: supply,
      }),
    );
    await execute(
      ERC20.v0_1.adjustAllowance.invocation(token.address, gas, {
        spender: pool.handler,
        difference: liquidity + 1_000_000n,
      }),
    );
  }
  const balance = async (address: typeof factory) =>
    (
      await ERC20.v0_1.getBalanceOf.view({
        client,
        address,
        args: { addr: account.address },
        minStateBlockHeight: height,
      })
    ).value;
  async function crank() {
    const receipt = await execute(
      SwapDriver.v0_1.processRequests.invocation(
        pool.driver,
        gasAmount(CRANK_FRAME_GAS),
      ),
    );
    assert.deepEqual(
      batch_driver.v0_1.events.RequestsProcessed.singleFromReceipt(receipt, {
        address: pool.driver,
      }).fields,
      { processed: 1n, failed: 0n },
    );
  }
  await execute(
    SwapRouter.v0_1.addLiquidity.invocation(router, gas, {
      tokenA,
      tokenB,
      amountsDesired: [liquidity, liquidity],
      amountsMin: [liquidity, liquidity],
      recipient: account.address,
    }),
  );
  await crank();
  assert.equal(await balance(pool.liquidity_token), liquidity - 1_000n);
  assert.equal(await balance(tokenA), supply - liquidity);
  assert.equal(await balance(tokenB), supply - liquidity);
  const state = (
    await SwapHandler.v0_1.poolState.view({
      client,
      address: pool.handler,
      minStateBlockHeight: height,
    })
  ).value;
  assert.deepEqual(state.reserves, [liquidity, liquidity]);

  const amountIn = 1_000_000n;
  // Constant-product output with the contract's 0.3% fee, calculated independently.
  const expectedOut =
    (amountIn * 997n * liquidity) / (liquidity * 1000n + amountIn * 997n);
  await execute(
    SwapRouter.v0_1.swapExactTokensForTokens.invocation(router, gas, {
      amountIn,
      amountOutMin: expectedOut,
      tokenIn: tokenA,
      tokenOut: tokenB,
      recipient: account.address,
    }),
  );
  await crank();
  assert.equal(await balance(tokenA), supply - liquidity - amountIn);
  assert.equal(await balance(tokenB), supply - liquidity + expectedOut);
}

async function startNode(): Promise<string> {
  const child = groups.spawn(
    process.env.THRUPUT_CLI ?? "thruput",
    [
      "node",
      "--json",
      "--port",
      "0",
      "--init-network-hash",
      toBase58(new Uint8Array(32).fill(1)),
      ...(process.env.THRUPUT_DEVNODE_BINARY
        ? ["--hog-devnode-binary", process.env.THRUPUT_DEVNODE_BINARY]
        : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(work, "config"),
        XDG_DATA_HOME: join(work, "data"),
        XDG_CACHE_HOME: join(work, "cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  let spawnError: Error | undefined;
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", (error: Error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.ok(!interrupted, "Swap checks interrupted");
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Node stopped: ${stderr}`);
    assert.equal(child.signalCode, null, `Node stopped: ${stderr}`);
    let startup: { data?: { rpcUrl?: string } } | undefined;
    try {
      startup = JSON.parse(stdout);
    } catch {
      /* Wait for complete startup JSON. */
    }
    if (startup?.data?.rpcUrl) return startup.data.rpcUrl;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Node startup timed out: ${stderr}`);
}
