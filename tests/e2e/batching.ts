// Explicit live-node probe for the proposed wallet batch boundaries.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  addressFromHex,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  fixedBytes,
  hashContract,
  HttpTransport,
  localnet,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { DefaultWallet } from "@groundhogchain/client/contracts";
import {
  ContractType,
  ExecResult,
  gasAmount,
  HOG_ADDRESS,
  type Contract,
  type Invocation,
} from "@groundhogchain/protocol";
import { StandardTokenFactory } from "../../apps/token-launchpad/src/contracts/generated/standard-token-factory.ts";
import { ERC20 } from "../../apps/swap/src/contracts/generated/erc20.ts";
import { SwapFactory } from "../../apps/swap/src/contracts/generated/swap-factory.ts";
import { SwapRouter } from "../../apps/swap/src/contracts/generated/swap-router.ts";
import {
  SwapDriver,
  batch_driver,
} from "../../apps/swap/src/contracts/generated/swap-driver.ts";
import { CRANK_FRAME_GAS } from "../../apps/swap/src/contracts/driver-target.ts";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

const RequestsProcessed = batch_driver.v0_1.events.RequestsProcessed;
type RequestsProcessed = batch_driver.v0_1.events.RequestsProcessed;

assert.ok(
  process.env.THRUPUT_DEVNODE_BINARY,
  "Set THRUPUT_DEVNODE_BINARY to a compatible hog-devnode executable",
);

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "groundhog-batching-"));
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
  child.stdout!.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr!.on("data", (data: Buffer) => {
    output += data.toString();
  });
  return { child, output: () => output };
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
      "--dev-account-count",
      "0",
      "--hog-devnode-binary",
      process.env.THRUPUT_DEVNODE_BINARY,
    ],
  );
  let startup:
    | {
        ok: boolean;
        data: { rpc_url: string; runtime_manifest: { path: string } };
      }
    | undefined;
  await until(() => {
    assert.equal(node.child.exitCode, null, node.output());
    try {
      startup = JSON.parse(node.output().slice(node.output().indexOf("{")));
    } catch {
      return false;
    }
    return startup?.ok === true;
  });
  const rpcUrl = startup!.data.rpc_url;
  const configs: Record<string, Record<string, string>> = {};
  for (const [app, prefix] of [
    ["token-launchpad", "LAUNCHPAD"],
    ["swap", "SWAP"],
  ]) {
    const output = join(work, `${app}.env`);
    const setup = spawn(
      join(root, "node_modules/.bin/tsx"),
      [`apps/${app}/scripts/setup-local.ts`],
      {
        GROUNDHOG_RPC_URL: rpcUrl,
        GROUNDHOG_RUNTIME_MANIFEST: startup!.data.runtime_manifest.path,
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
  const client = await createGroundhogClient({
    cluster: localnet({ rpcUrl }),
    transport: new HttpTransport(rpcUrl),
  });
  console.log("Runtime:", await client.getVersion());
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  await wallet.requestAirdrop();
  const tokenFactory = addressFromHex(
    configs["token-launchpad"]!.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!,
  );
  const swapFactory = addressFromHex(configs.swap!.VITE_SWAP_FACTORY_ADDRESS!);
  const router = addressFromHex(configs.swap!.VITE_SWAP_ROUTER_ADDRESS!);
  async function code(name: string): Promise<Contract> {
    return {
      contract_type: ContractType.kRv32,
      rv32_contract: { data: await readFile(join(artifacts, `${name}.rv32a`)) },
    };
  }
  const tokenCode = await code("standard_token");
  const lpCode = await code("erc20");
  assert.equal(
    toHex0x(hashContract(tokenCode)),
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
    console.log(label, toHex0x(hash), ExecResult[receipt.execResult]);
    return receipt;
  }
  const invalidNonce = fixedBytes(randomBytes(32), 32);
  const rollbackAddress = (
    await StandardTokenFactory.v0_1.predictToken.view({
      client,
      contract: tokenFactory,
      args: { creator: account.address, nonce: invalidNonce },
    })
  ).value;
  const rejected = await batch(
    "Rollback funding when token initialization fails",
    [
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
        receiver: rollbackAddress,
        amount: 1_000_000n,
      }),
      StandardTokenFactory.v0_1.createToken.invocation(tokenFactory, gas, {
        nonce: invalidNonce,
        name: "Invalid",
        symbol: "INVALID",
        decimals: 6n,
        initialSupply: 1n << 127n,
        administrator: account.address,
        initialHolder: account.address,
      }),
    ],
    [tokenCode],
  );
  assert.notEqual(rejected.execResult, ExecResult.ExecResultOK);
  assert.equal((await wallet.getBalance(rollbackAddress)).rawBalance, 0n);
  assert.equal(rejected.events.length, 0);
  const retry = await batch(
    "Retry the same token nonce after rollback",
    [
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
        receiver: rollbackAddress,
        amount: 1_000_000n,
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
  assert.equal(retry.execResult, ExecResult.ExecResultOK);
  assert.equal(
    (
      await ERC20.v0_1.getBalanceOf.view({
        client,
        contract: rollbackAddress,
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
        contract: tokenFactory,
        args: { creator: account.address, nonce },
      })
    ).value;
    const funding = ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
      receiver: predicted,
      amount: 1_000_000n,
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
    assert.equal(receipt.execResult, ExecResult.ExecResultOK);
    assert.equal(
      (
        await ERC20.v0_1.getBalanceOf.view({
          client,
          contract: predicted,
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
  const pool = (
    await SwapFactory.v0_1.poolAddresses.view({
      client,
      contract: swapFactory,
      args: { tokenA: token0!, tokenB: token1! },
    })
  ).value;
  const funding = (
    await SwapFactory.v0_1.poolFunding.view({ client, contract: swapFactory })
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
  assert.equal(receipt.execResult, ExecResult.ExecResultOK);
  assert.equal(
    (
      await batch("Process liquidity", [
        SwapDriver.v0_1.processRequests.invocation(
          pool.driver,
          gasAmount(CRANK_FRAME_GAS),
        ),
      ])
    ).execResult,
    ExecResult.ExecResultOK,
  );
  const lpBalance = (
    await ERC20.v0_1.getBalanceOf.view({
      client,
      contract: pool.liquidity_token,
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
    ).execResult,
    ExecResult.ExecResultOK,
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
      ).execResult,
      ExecResult.ExecResultOK,
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
  assert.equal(drained.execResult, ExecResult.ExecResultOK);
  assert.deepEqual(
    RequestsProcessed.singleFromReceipt(drained, {
      contractAddress: pool.driver,
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
