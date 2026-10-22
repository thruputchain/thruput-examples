// Explicit live-node probe for the proposed wallet batch boundaries.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  addressFromBase58,
  addressFromHex,
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  fixedBytes,
  hashContract,
  HttpTransport,
  localnet,
  prepareContractDeployment,
  Ed25519Signer,
  toBase58,
  toHex0x,
  TransactionReceiptTimeoutError,
  serializeSignedTransaction,
} from "@thruputchain/client";
import { DefaultWallet } from "@thruputchain/client/contracts";
import {
  ContractType,
  gasAmount,
  HOG_ADDRESS,
  type Contract,
  type Invocation,
} from "@thruputchain/protocol";
import { StandardTokenFactory } from "../../apps/token-launchpad/src/contracts/generated/standard-token-factory.ts";
import { StandardTokenInitializer } from "../../apps/token-launchpad/src/contracts/generated/standard-token.ts";
import { ERC20 } from "../../apps/swap/src/contracts/generated/erc20.ts";
import { SwapFactory } from "../../apps/swap/src/contracts/generated/swap-factory.ts";
import { SwapRouter } from "../../apps/swap/src/contracts/generated/swap-router.ts";
import {
  SwapDriver,
  batch_driver,
} from "../../apps/swap/src/contracts/generated/swap-driver.ts";
import { CRANK_FRAME_GAS } from "../../apps/swap/src/contracts/driver-target.ts";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";
import { waitForView } from "../../examples/typescript/wait-for-view.ts";

const RequestsProcessed = batch_driver.v0_1.events.RequestsProcessed;
type RequestsProcessed = batch_driver.v0_1.events.RequestsProcessed;

assert.ok(
  process.env.THRUPUT_DEVNODE_BINARY,
  "Set THRUPUT_DEVNODE_BINARY to a compatible hog-devnode executable",
);

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-batching-"));
const groups = new OwnedProcessGroups();
let interrupted = false;
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void groups.stopAll().catch(() => console.error("Batch test cleanup failed"));
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 5 * 60_000);
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: join(work, "config"),
  XDG_DATA_HOME: join(work, "data"),
  XDG_CACHE_HOME: join(work, "cache"),
};
const gas = gasAmount(10_000_000n);
const artifacts =
  process.env.BATCH_TEST_ARTIFACT_ROOT ?? join(root, "target/thruput");
function spawn(command: string, args: string[], extra = {}) {
  assert.ok(!interrupted, "Batch test interrupted");
  const child = groups.spawn(command, args, {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  child.stdout!.on("data", (data: Buffer) => {
    stdout += data.toString();
    output += data.toString();
  });
  child.stderr!.on("data", (data: Buffer) => {
    output += data.toString();
  });
  return { child, output: () => output, stdout: () => stdout };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 120_000;
  while (!check()) {
    assert.ok(!interrupted, "Batch test interrupted");
    assert.ok(Date.now() < deadline, "Timed out waiting for isolated node");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

try {
  const node = spawn(
    process.env.THRUPUT_CLI ?? join(homedir(), ".cargo/bin/thruput"),
    [
      "node",
      "--json",
      "--port",
      "0",
      "--hog-devnode-binary",
      process.env.THRUPUT_DEVNODE_BINARY,
    ],
  );
  let startup:
    | {
        ok: boolean;
        data: { rpcUrl: string; runtimeManifest: { path: string } };
      }
    | undefined;
  await until(() => {
    assert.equal(node.child.exitCode, null, node.output());
    try {
      startup = JSON.parse(node.stdout());
    } catch {
      return false;
    }
    return startup?.ok === true;
  });
  const rpcUrl = startup!.data.rpcUrl;
  const configs: Record<string, Record<string, string | undefined>> = {};
  for (const [app, prefix] of [
    ["token-launchpad", "LAUNCHPAD"],
    ["swap", "SWAP"],
  ]) {
    const output = join(work, `${app}.env`);
    const setup = spawn(
      join(root, "node_modules/.bin/tsx"),
      [`apps/${app}/scripts/setup-local.ts`],
      {
        THRUPUT_RPC_URL: rpcUrl,
        THRUPUT_RUNTIME_MANIFEST: startup!.data.runtimeManifest.path,
        [`${prefix}_ARTIFACT_ROOT`]: artifacts,
        [`${prefix}_APP_ENV`]: output,
        [`${prefix}_APP_PUBLIC_DIR`]: join(work, app!),
      },
    );
    await until(
      () => setup.child.exitCode !== null || setup.child.signalCode !== null,
    );
    assert.equal(setup.child.exitCode, 0, setup.output());
    configs[app!] = parseEnv(await readFile(output, "utf8"));
  }
  const client = await createThruputClient({
    cluster: localnet({ rpcUrl }),
    transport: new HttpTransport(rpcUrl),
  });
  console.log("Runtime:", await client.getVersionInfo());
  const account = createPubkeyAccount({
    signer: new Ed25519Signer(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  await wallet.requestAirdrop();
  const tokenFactory = addressFromBase58(
    configs["token-launchpad"]!.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!,
  );
  const tokenFunding =
    (
      await StandardTokenFactory.v0_1.requiredTokenFunding.view({
        client,
        address: tokenFactory,
      })
    ).value +
    BigInt(configs["token-launchpad"]!.VITE_NATIVE_BALANCE_ITEM_COST!);
  const swapFactory = addressFromBase58(
    configs.swap!.VITE_SWAP_FACTORY_ADDRESS!,
  );
  const router = addressFromBase58(configs.swap!.VITE_SWAP_ROUTER_ADDRESS!);
  async function code(name: string): Promise<Contract> {
    return {
      contract_type: ContractType.kRv32,
      rv32_contract: { data: await readFile(join(artifacts, `${name}.rv32a`)) },
    };
  }
  const tokenCode = await code("standard_token");
  const lpCode = await code("erc20");
  assert.equal(
    toBase58(hashContract(tokenCode)),
    configs["token-launchpad"]!.VITE_STANDARD_TOKEN_HASH,
  );
  async function batch(
    label: string,
    invocations: Invocation[],
    contractsToDeploy: Contract[] = [],
  ) {
    const hash = await wallet.sendInvocation({
      invocation: DefaultWallet.v0_1.execute.invocation(
        account.address,
        gasAmount(
          invocations.reduce(
            (total, call) => total + call.gas_limit,
            5_000_000n,
          ),
        ),
        {
          calls: invocations.map((call) => ({
            target: call.invoked_address,
            entrypoint: fixedBytes(call.entrypoint, 8),
            gas_limit: call.gas_limit,
            calldata: call.calldata,
          })),
        },
      ),
      contractsToDeploy,
    });
    const receipt = await wallet.waitForTransactionReceipt(hash, {
      timeoutMs: 60_000,
    });
    assert.ok("result" in receipt.execution, "Unsupported execution result");
    console.log(label, toBase58(hash), receipt.execution.result);
    return { ...receipt, execution: receipt.execution };
  }
  const invalidNonce = fixedBytes(randomBytes(32), 32);
  const rollbackAddress = (
    await StandardTokenFactory.v0_1.predictToken.view({
      client,
      address: tokenFactory,
      args: { creator: account.address, nonce: invalidNonce },
    })
  ).value;
  const rejected = await batch(
    "Rollback funding when token creation fails",
    [
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
        receiver: rollbackAddress,
        amount: tokenFunding,
      }),
      StandardTokenFactory.v0_1.createToken.invocation(tokenFactory, gas, {
        nonce: invalidNonce,
        name: "Invalid",
        symbol: "INVALID",
        decimals: 6n,
        initialSupply: -1n,
        administrator: account.address,
        initialHolder: account.address,
      }),
    ],
    [tokenCode],
  );
  assert.equal(rejected.execution.result, "abort");
  assert.equal(
    (await wallet.getBalance({ address: rollbackAddress })).rawBalance,
    0n,
  );
  assert.equal(rejected.events.length, 0);
  const retry = await batch(
    "Retry the same token nonce after rollback",
    [
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
        receiver: rollbackAddress,
        amount: tokenFunding,
      }),
      StandardTokenFactory.v0_1.createToken.invocation(tokenFactory, gas, {
        nonce: invalidNonce,
        name: "Recovered",
        symbol: "RECOVERED",
        decimals: 6n,
        initialSupply: 1n,
        administrator: account.address,
        initialHolder: account.address,
      }),
    ],
    [tokenCode],
  );
  assert.equal(retry.execution.result, "return");
  assert.equal(
    (
      await ERC20.v0_1.getBalanceOf.view({
        client,
        address: rollbackAddress,
        args: { addr: account.address },
      })
    ).value,
    1n,
  );
  const tokens = [];
  for (const symbol of ["ALPHA", "BETA"]) {
    const nonce = fixedBytes(randomBytes(32), 32);
    const predicted = (
      await StandardTokenFactory.v0_1.predictToken.view({
        client,
        address: tokenFactory,
        args: { creator: account.address, nonce },
      })
    ).value;
    const funding = ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
      receiver: predicted,
      amount: tokenFunding,
    });
    const creation = StandardTokenFactory.v0_1.createToken.invocation(
      tokenFactory,
      gas,
      {
        nonce,
        name: symbol,
        symbol,
        decimals: 6n,
        initialSupply: 1_000_000_000_000n,
        administrator: account.address,
        initialHolder: account.address,
      },
    );
    const receipt = await batch(
      `${symbol}: fund and create`,
      [funding, creation],
      [tokenCode],
    );
    assert.equal(receipt.execution.result, "return");
    assert.equal(
      (
        await ERC20.v0_1.getBalanceOf.view({
          client,
          address: predicted,
          args: { addr: account.address },
        })
      ).value,
      1_000_000_000_000n,
    );
    tokens.push(predicted);
  }
  const [token0, token1] = tokens.sort((a, b) =>
    toHex0x(a).localeCompare(toHex0x(b)),
  );
  // Native wallet batching covers reserve top-up + transfer without a custom test wallet.
  const receiver = addressFromHex(`0x${"44".repeat(32)}`);
  const readBalance = (
    token: typeof receiver,
    owner: typeof receiver,
    minHeight: bigint,
  ) =>
    waitForView(() =>
      ERC20.v0_1.getBalanceOf.view({
        client,
        address: token,
        args: { addr: owner },
        minStateBlockHeight: minHeight,
      }),
    );
  // Measure the cost of this exact token shape, then deploy an identical token
  // with no spare reserve. The factory's normal funding floor is intentionally
  // generous, so a factory-created token cannot prove that a top-up is needed.
  async function deployReserveToken(amount: bigint) {
    const deployment = prepareContractDeployment({
      deployer: account.address,
      contract: tokenCode,
    });
    return wallet.deployContractAndWait(
      deployment,
      {
        amount,
        gasLimit: gas,
        initializer:
          StandardTokenInitializer.v0_1.initializeFromFactory.invocation(
            deployment.address,
            gas,
            {
              administrator: account.address,
              initialHolder: account.address,
              initialSupply: 10n,
              name: "Reserve test",
              symbol: "RES",
              decimals: 6n,
            },
          ),
      },
      { timeoutMs: 60_000 },
    );
  }
  const calibrationFunding = 1_000_000n;
  const calibration = await deployReserveToken(calibrationFunding);
  const spare = (
    await readBalance(
      HOG_ADDRESS,
      calibration.address,
      calibration.receipt.blockHeight,
    )
  ).value;
  const initializationCost = calibrationFunding - spare;
  assert.ok(initializationCost > 0n && initializationCost < calibrationFunding);
  const depleted = await deployReserveToken(initializationCost);
  const reserveToken = depleted.address;
  assert.equal(
    (await readBalance(HOG_ADDRESS, reserveToken, depleted.receipt.blockHeight))
      .value,
    0n,
  );
  assert.equal(
    (
      await readBalance(
        reserveToken,
        account.address,
        depleted.receipt.blockHeight,
      )
    ).value,
    10n,
  );
  const transfer = ERC20.v0_1.transfer.invocation(reserveToken, gas, {
    receiver,
    amount: 1n,
  });
  const unfunded = await wallet.prepareExecution({
    invocation: transfer,
    gasLimit: gas,
    expiryBlocks: 1n,
  });
  const { transactionHash: unfundedHash } = await wallet.sendTransaction({
    signedTransaction: serializeSignedTransaction(
      await wallet.signTransaction(unfunded),
    ),
  });
  await assert.rejects(
    wallet.waitForTransactionReceipt(unfundedHash, { timeoutMs: 3_000 }),
    (error: unknown) =>
      error instanceof TransactionReceiptTimeoutError &&
      error.lastStatus !== undefined &&
      "status" in error.lastStatus &&
      error.lastStatus.status === "retry" &&
      error.lastStatus.error.source === "executor" &&
      error.lastStatus.error.code === 3,
  );
  console.log(
    "Transfer alone cannot commit with zero storage reserve",
    toBase58(unfundedHash),
  );
  // This is a scheduler retry, not a committed revert. Expire it while the
  // reserve is still zero so it cannot execute later using the batch's top-up.
  for (
    let blocks = 0;
    (await client.getChainTip()).blockHeight <=
    unfunded.uniquifier.block_expiry_height;
    blocks++
  ) {
    assert.ok(
      blocks < 3,
      "The unfunded control must expire before adding reserve",
    );
    assert.equal(
      (
        await batch("Advance beyond the unfunded control's expiry", [
          ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
            receiver: account.address,
            amount: 0n,
          }),
        ])
      ).execution.result,
      "return",
    );
  }
  assert.equal(
    await client.getTransactionReceipt({ transactionHash: unfundedHash }),
    null,
  );
  const controlHeight = (await client.getChainTip()).blockHeight;
  assert.equal(
    (await readBalance(reserveToken, receiver, controlHeight)).value,
    0n,
  );
  assert.equal(
    (await readBalance(reserveToken, account.address, controlHeight)).value,
    10n,
  );

  const topupAmount = 100_000n;
  const topup = ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
    receiver: reserveToken,
    amount: topupAmount,
  });
  const failedTransfer = await batch(
    "Roll back reserve top-up when transfer fails",
    [
      topup,
      ERC20.v0_1.transfer.invocation(reserveToken, gas, {
        receiver,
        amount: 11n,
      }),
    ],
  );
  assert.equal(failedTransfer.execution.result, "abort");
  assert.equal(
    (await readBalance(HOG_ADDRESS, reserveToken, failedTransfer.blockHeight))
      .value,
    0n,
  );
  assert.equal(
    (await readBalance(reserveToken, receiver, failedTransfer.blockHeight))
      .value,
    0n,
  );
  const fundedTransfer = await batch(
    "Top up storage and transfer to a new holder",
    [topup, transfer],
  );
  assert.equal(fundedTransfer.execution.result, "return");
  assert.equal(
    (await readBalance(reserveToken, receiver, fundedTransfer.blockHeight))
      .value,
    1n,
  );
  assert.equal(
    (
      await readBalance(
        reserveToken,
        account.address,
        fundedTransfer.blockHeight,
      )
    ).value,
    9n,
  );
  const reserveAfter = (
    await readBalance(HOG_ADDRESS, reserveToken, fundedTransfer.blockHeight)
  ).value;
  assert.ok(
    reserveAfter >= 0n && reserveAfter < topupAmount,
    "The new holder row must spend reserve added by this batch",
  );
  const pool = (
    await SwapFactory.v0_1.poolAddresses.view({
      client,
      address: swapFactory,
      args: { tokenA: token0!, tokenB: token1! },
    })
  ).value;
  const funding = (
    await SwapFactory.v0_1.poolFunding.view({ client, address: swapFactory })
  ).value.recommended;
  const amount = 1_000_000_000n;
  const calls = [
    ERC20.v0_1.adjustAllowance.invocation(HOG_ADDRESS, gas, {
      spender: swapFactory,
      difference: funding * 3n,
    }),
    SwapFactory.v0_1.createPair.invocation(swapFactory, gas, {
      tokenA: token0!,
      tokenB: token1!,
      funding,
    }),
    ERC20.v0_1.adjustAllowance.invocation(token0!, gas, {
      spender: pool.handler,
      difference: amount,
    }),
    ERC20.v0_1.adjustAllowance.invocation(token1!, gas, {
      spender: pool.handler,
      difference: amount,
    }),
    SwapRouter.v0_1.addLiquidity.invocation(router, gas, {
      tokenA: token0!,
      tokenB: token1!,
      amountsDesired: [amount, amount],
      amountsMin: [amount, amount],
      recipient: account.address,
    }),
  ];
  const receipt = await batch(
    "Create pool, approve tokens, enqueue liquidity",
    calls,
    [lpCode],
  );
  assert.equal(receipt.execution.result, "return");
  assert.equal(
    (
      await batch("Process liquidity", [
        SwapDriver.v0_1.processRequests.invocation(
          pool.driver,
          gasAmount(CRANK_FRAME_GAS),
        ),
      ])
    ).execution.result,
    "return",
  );
  const lpBalance = (
    await ERC20.v0_1.getBalanceOf.view({
      client,
      address: pool.liquidity_token,
      args: { addr: account.address },
    })
  ).value;
  assert.equal(lpBalance, 999_999_000n);
  console.log("LP balance:", lpBalance);
  assert.equal(
    (
      await batch("Approve eight queued swaps", [
        ERC20.v0_1.adjustAllowance.invocation(token0!, gas, {
          spender: pool.handler,
          difference: 8_000n,
        }),
      ])
    ).execution.result,
    "return",
  );
  for (let i = 0; i < 8; i++) {
    assert.equal(
      (
        await batch(`Queue swap ${i + 1}`, [
          SwapRouter.v0_1.swapExactTokensForTokens.invocation(router, gas, {
            amountIn: 1_000n,
            amountOutMin: 1n,
            tokenIn: token0!,
            tokenOut: token1!,
            recipient: account.address,
          }),
        ])
      ).execution.result,
      "return",
    );
  }
  const drained = await batch(
    "Crank eight-request backlog with the app budget",
    [
      SwapDriver.v0_1.processRequests.invocation(
        pool.driver,
        gasAmount(CRANK_FRAME_GAS),
      ),
    ],
  );
  assert.equal(drained.execution.result, "return");
  assert.deepEqual(
    RequestsProcessed.singleFromReceipt(drained, {
      address: pool.driver,
    }).fields,
    { processed: 8n, failed: 0n },
  );
  console.log("Evidence:", work);
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await groups.stopAll();
}
