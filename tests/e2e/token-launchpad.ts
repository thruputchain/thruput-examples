// Explicit live check: npm run test:token-launchpad (generate bindings first).
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
  fixedBytes,
  fromHex0x,
  hashContract,
  toBase58,
} from "@thruputchain/client";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
} from "@thruputchain/protocol";
import { setup } from "../../apps/token-launchpad/scripts/index";
import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../../apps/token-launchpad/src/contracts/generated/standard-token-factory";
import {
  ERC20,
  ERC20Metadata,
} from "../../apps/token-launchpad/src/contracts/generated/standard-token";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-launchpad-"));
const groups = new OwnedProcessGroups();
let interrupted = false;
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void groups.stopAll().catch(console.error);
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 180_000);

try {
  const rpcUrl = await startNode();
  const env = {
    THRUPUT_RPC_URL: rpcUrl,
    LAUNCHPAD_APP_ENV: join(work, ".env.local"),
    LAUNCHPAD_APP_PUBLIC_DIR: join(work, "public"),
  };
  const local = await setup(env);
  await checkTokenCreation(local, env.LAUNCHPAD_APP_ENV, 1_000_000n);
  const devnet = await setup(
    { ...env, LAUNCHPAD_APP_ENV: join(work, ".env.devnet") },
    "devnet",
  );
  assert.notDeepEqual(local.address, devnet.address);
  await checkTokenCreation(devnet, join(work, ".env.devnet"), 10_000_000n);
  const before = await readFile(env.LAUNCHPAD_APP_ENV, "utf8");
  await assert.rejects(() =>
    setup({ ...env, THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)) }),
  );
  assert.equal(await readFile(env.LAUNCHPAD_APP_ENV, "utf8"), before);
  console.log(`Launchpad end-to-end checks passed. Evidence: ${work}`);
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await groups.stopAll();
}

async function checkTokenCreation(
  { client, address: factory }: Awaited<ReturnType<typeof setup>>,
  output: string,
  requiredFunding: bigint,
) {
  assert.ok(!interrupted, "Launchpad checks interrupted");
  const env = parseEnv(await readFile(output, "utf8"));
  assert.equal(
    env.VITE_THRUPUT_NETWORK_ID,
    toBase58(new Uint8Array(32).fill(1)),
  );
  assert.equal(env.VITE_STANDARD_TOKEN_FACTORY_ADDRESS, toBase58(factory));
  const asset = JSON.parse(
    await readFile(
      join(
        work,
        "public/contract-artifacts",
        `${env.VITE_STANDARD_TOKEN_HASH}.json`,
      ),
      "utf8",
    ),
  );
  const contract = {
    contract_type: ContractType.kRv32 as const,
    rv32_contract: { data: fromHex0x(asset.data) },
  };
  assert.equal(toBase58(hashContract(contract)), env.VITE_STANDARD_TOKEN_HASH);
  const config = (
    await StandardTokenFactory.v0_1.config.view({ client, address: factory })
  ).value;
  assert.equal(config.required_token_funding, requiredFunding);
  const account = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  await wallet.requestAirdrop();
  const nonce = fixedBytes(randomBytes(32), 32);
  const address = (
    await StandardTokenFactory.v0_1.predictToken.view({
      client,
      address: factory,
      args: { creator: account.address, nonce },
    })
  ).value;
  const gas = gasAmount(10_000_000n);
  // Match the browser: prefund the exact policy amount plus the balance-row charge.
  await wallet.executeAndWait(
    {
      gasLimit: gas,
      invocation: ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, gas, {
        receiver: address,
        amount: requiredFunding + 1234n,
      }),
    },
    { timeoutMs: 60_000 },
  );
  const { receipt } = await wallet.executeAndWait(
    {
      gasLimit: gas,
      contractsToDeploy: [contract],
      invocation: StandardTokenFactory.v0_1.createToken.invocation(
        factory,
        gas,
        {
          nonce,
          administrator: account.address,
          initialHolder: account.address,
          initialSupply: 1_000_000n,
          name: "Setup acceptance token",
          symbol: "SET",
          decimals: 6n,
        },
      ),
    },
    { timeoutMs: 60_000 },
  );
  const created =
    standard_token_factory_if.v0_1.events.TokenCreated.singleFromReceipt(
      receipt,
      { address: factory },
    );
  assert.deepEqual(created.topics.token, address);
  assert.deepEqual(created.topics.creator, account.address);
  assert.equal(created.fields.initial_supply, 1_000_000n);
  const view = { client, address, minStateBlockHeight: receipt.blockHeight };
  assert.equal((await ERC20.v0_1.totalSupply.view(view)).value, 1_000_000n);
  assert.equal(
    (
      await ERC20.v0_1.getBalanceOf.view({
        ...view,
        args: { addr: account.address },
      })
    ).value,
    1_000_000n,
  );
  assert.equal((await ERC20Metadata.v0_1.symbol.view(view)).value, "SET");
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
    assert.ok(!interrupted, "Launchpad checks interrupted");
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
