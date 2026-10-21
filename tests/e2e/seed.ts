// Runs only when explicitly invoked with `npm run test:seed`.
import assert from "node:assert/strict";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  addressFromBase58,
  createThruputClient,
  hashFromBase58,
  HttpTransport,
  localnet,
  toBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import { ERC20 } from "@thruputchain/client/contracts";
import { SwapFactory } from "../../apps/swap/src/contracts/generated/swap-factory.ts";
import { SwapHandler } from "../../apps/swap/src/contracts/generated/swap-handler.ts";
import { createThruputRegistrySource } from "../../apps/token-launchpad/server/chain.ts";
import { RegistryStore } from "../../apps/token-launchpad/server/store.ts";
import { RegistryIndexer } from "../../apps/token-launchpad/server/indexer.ts";

assert.ok(
  process.env.THRUPUT_DEVNODE_BINARY,
  "Set THRUPUT_DEVNODE_BINARY to a compatible hog-devnode executable",
);

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-seed-"));
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ["PATH", "HOME", "LANG", "LD_LIBRARY_PATH"].includes(key),
  ),
);
Object.assign(env, {
  XDG_CONFIG_HOME: join(work, "config"),
  XDG_DATA_HOME: join(work, "data"),
  XDG_CACHE_HOME: join(work, "cache"),
  SEED_STATE_DIR: join(work, "seed"),
  SEED_RECIPIENT: toBase58(new Uint8Array(32).fill(0x42)),
});
const processGroups = new OwnedProcessGroups();
let interrupted = false;
function start(command: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  assert.ok(!interrupted, "Seed test interrupted");
  const child = processGroups.spawn(command, args, {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  child.on("error", (error: Error) => {
    output += error.message;
  });
  child.stdout!.on("data", (data: Buffer) => {
    stdout += data.toString();
    output += data.toString();
  });
  child.stderr!.on("data", (data: Buffer) => {
    output += data.toString();
  });
  return { child, output: () => output, stdout: () => stdout };
}
async function until(
  check: () => boolean | Promise<boolean>,
  diagnostics: () => string = () => "",
) {
  const deadline = Date.now() + 120_000;
  while (!(await check())) {
    assert.ok(!interrupted, "Seed test interrupted");
    assert.ok(
      Date.now() < deadline,
      `Timed out waiting for isolated test process: ${diagnostics()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function run(
  app: string,
  script: string,
  overrides: NodeJS.ProcessEnv = {},
  expectedExit = 0,
) {
  const process = start(
    join(root, "node_modules/.bin/tsx"),
    [
      join(
        root,
        script.startsWith("seed-")
          ? `apps/${app}/scripts/seed.ts`
          : `apps/${app}/scripts/${script}.ts`,
      ),
    ],
    overrides,
  );
  await until(
    () => process.child.exitCode !== null || process.child.signalCode !== null,
  );
  // Seed runners emit only public progress; setup failures can include RPC data.
  if (script.startsWith("seed-")) console.log(process.output());
  assert.equal(
    process.child.exitCode,
    expectedExit,
    `${script} unexpected exit`,
  );
  return process.output();
}
const protectedPaths = ["swap", "token-launchpad"].map((app) =>
  join(root, `apps/${app}/.env.local`),
);
const fingerprint = async (path: string) => {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const before = await Promise.all(protectedPaths.map(fingerprint));
let store: RegistryStore | undefined;
let indexer: RegistryIndexer | undefined;
let stage = "isolated node startup";
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void processGroups.stopAll().catch(() => {
    console.error("Seed test process cleanup failed; temporary state retained");
  });
}
const watchdog = setTimeout(interrupt, 15 * 60_000);
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const node = start(
    process.env.THRUPUT_CLI ?? join(homedir(), ".cargo/bin/thruput"),
    [
      "node",
      "--json",
      "--port",
      "0",
      "--hog-devnode-binary",
      process.env.THRUPUT_DEVNODE_BINARY,
      ...(process.env.THRUPUT_E2E_HOGD_PROTOCOL
        ? ["--hogd-protocol", process.env.THRUPUT_E2E_HOGD_PROTOCOL]
        : []),
    ],
  );
  let startup:
    | {
        ok: boolean;
        data: { rpcUrl: string; runtimeManifest: { path: string } };
      }
    | undefined;
  await until(
    () => {
      assert.equal(
        node.child.exitCode,
        null,
        `Isolated node exited during startup: ${node.output().replace(/(?:0x)?[0-9a-fA-F]{64}/g, "[hex32]")}`,
      );
      try {
        const text = node.stdout();
        startup = JSON.parse(text.slice(text.indexOf("{")));
      } catch {
        return false;
      }
      return startup?.ok === true;
    },
    () => node.output().replace(/(?:0x)?[0-9a-fA-F]{64}/g, "[hex32]"),
  );
  Object.assign(env, {
    THRUPUT_RPC_URL: startup!.data.rpcUrl,
    THRUPUT_RUNTIME_MANIFEST: startup!.data.runtimeManifest.path,
  });
  stage = "infrastructure setup";
  for (const [app, prefix] of [
    ["swap", "SWAP"],
    ["token-launchpad", "LAUNCHPAD"],
  ]) {
    Object.assign(env, {
      [`${prefix}_ARTIFACT_ROOT`]:
        process.env.SEED_TEST_ARTIFACT_ROOT ?? join(root, "target/thruput"),
      [`${prefix}_APP_ENV`]: join(work, `${prefix}.env`),
      [`${prefix}_APP_PUBLIC_DIR`]: join(work, `${prefix}/public`),
    });
    await run(app!, "setup-local");
  }
  const launch = parseEnv(await readFile(env.LAUNCHPAD_APP_ENV!, "utf8"));
  const swap = parseEnv(await readFile(env.SWAP_APP_ENV!, "utf8"));
  const scope = {
    networkId: launch.VITE_THRUPUT_NETWORK_ID!,
    factoryAddress: launch.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!,
    tokenCodeHash: launch.VITE_STANDARD_TOKEN_HASH!,
  };
  const source = await createThruputRegistrySource({
    rpcUrl: new URL(env.THRUPUT_RPC_URL!),
    scope,
  });
  async function startRegistry() {
    store = new RegistryStore(join(work, "registry.sqlite"), scope);
    indexer = new RegistryIndexer(store, source, {
      pageSize: 200,
      syncIntervalMs: 1_000,
    });
    indexer.start();
    await indexer.sync();
    assert.equal(store.getStatus().syncState, "idle");
    assert.equal(store.getStatus().lastError, null);
  }
  await startRegistry();
  const client = await createThruputClient({
    cluster: localnet({
      rpcUrl: env.THRUPUT_RPC_URL!,
      networkHash: networkHash(hashFromBase58(launch.VITE_THRUPUT_NETWORK_ID!)),
    }),
    transport: new HttpTransport(env.THRUPUT_RPC_URL!),
  });
  const factory = addressFromBase58(swap.VITE_SWAP_FACTORY_ADDRESS!);
  const count = async () =>
    (await SwapFactory.v0_1.allPairsLength.view({ client, address: factory }))
      .value;
  assert.equal(await count(), 0n);
  assert.equal(store!.getStatus().tokenCount, 0);
  stage =
    "reject a router initialized for another factory before any seed writes";
  const otherSetup = join(work, "OTHER-SWAP.env");
  await run("swap", "setup-local", { SWAP_APP_ENV: otherSetup });
  const other = parseEnv(await readFile(otherSetup, "utf8"));
  const tipBeforeMismatch = (await client.getChainTip()).blockHeight;
  const mismatchedRouter = {
    VITE_SWAP_ROUTER_ADDRESS: other.VITE_SWAP_ROUTER_ADDRESS!,
  };
  await run("swap", "seed-pools", mismatchedRouter, 1);
  assert.equal((await client.getChainTip()).blockHeight, tipBeforeMismatch);
  await assert.rejects(readdir(env.SEED_STATE_DIR!), { code: "ENOENT" });
  assert.equal(await count(), 0n);
  assert.equal(store!.getStatus().tokenCount, 0);
  stage = "fresh token and pool seed commands";
  // Token seeding must not read Swap configuration or require its contracts.
  const tokensOutput = await run("token-launchpad", "seed-tokens", {
    SWAP_APP_ENV: join(work, "absent-swap.env"),
  });
  interface SeedResult {
    recipient: string;
    tokens: string[];
    pool?: { handler: string; liquidityToken: string };
  }
  function result(output: string): SeedResult {
    const json = output.match(/^Seed result: (.+)$/m)?.[1];
    assert.ok(json, "Seed must report public results");
    return JSON.parse(json) as SeedResult;
  }
  const tokens = result(tokensOutput);
  for (const token of tokens.tokens) {
    assert.equal(
      (
        await ERC20.v0_1.getBalanceOf.view({
          client,
          address: addressFromBase58(token),
          args: { addr: addressFromBase58(tokens.recipient) },
        })
      ).value,
      1_000_000n * 1_000_000n,
    );
  }
  // Swap seed creates its own tokens; no saved signer or running registry is needed.
  await indexer!.stop();
  const manifest = result(await run("swap", "seed-pools"));
  assert.ok(manifest.pool);
  assert.ok(manifest.tokens.every((token) => !tokens.tokens.includes(token)));
  assert.equal(await count(), 1n);
  for (const token of manifest.tokens) {
    assert.equal(
      (
        await ERC20.v0_1.getBalanceOf.view({
          client,
          address: addressFromBase58(token),
          args: { addr: addressFromBase58(manifest.recipient) },
        })
      ).value,
      999_000n * 1_000_000n,
    );
  }
  const pool = (
    await SwapHandler.v0_1.poolState.view({
      client,
      address: addressFromBase58(manifest.pool.handler),
    })
  ).value;
  assert.deepEqual(pool.reserves, [1_000_000_000n, 1_000_000_000n]);
  assert.ok(
    (
      await ERC20.v0_1.getBalanceOf.view({
        client,
        address: addressFromBase58(manifest.pool.liquidityToken),
        args: { addr: addressFromBase58(manifest.recipient) },
      })
    ).value > 0n,
  );
  stage = "validate inputs without writes, then create a fresh second pool";
  for (const overrides of [
    { SEED_RECIPIENT: "" },
    { SEED_RECIPIENT: toBase58(new Uint8Array(32)) },
    { VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(0x43)) },
    {
      VITE_STANDARD_TOKEN_FACTORY_ADDRESS: toBase58(
        new Uint8Array(32).fill(0x43),
      ),
    },
  ]) {
    const tip = (await client.getChainTip()).blockHeight;
    await run("token-launchpad", "seed-tokens", overrides, 1);
    assert.equal((await client.getChainTip()).blockHeight, tip);
  }
  const second = result(await run("swap", "seed-pools"));
  assert.ok(second.pool);
  assert.notEqual(second.pool.handler, manifest.pool.handler);
  assert.ok(second.tokens.every((token) => !manifest.tokens.includes(token)));
  assert.equal(await count(), 2n);
  await assert.rejects(readdir(env.SEED_STATE_DIR!), { code: "ENOENT" });
  store!.close();
  await startRegistry();
  await until(() => store!.getStatus().tokenCount === 6);
  assert.equal(store!.getStatus().tokenCount, 6);
  console.log(
    `PASS: fresh assets on rerun, no saved signer/journal, recipient balances/LP, reserves and indexing. Evidence: ${work}`,
  );
} catch (error) {
  console.error(
    `Isolated seed acceptance failed at ${stage}. Evidence: ${work}`,
  );
  throw error;
} finally {
  clearTimeout(watchdog);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  await indexer?.stop();
  store?.close();
  await processGroups.stopAll();
  assert.deepEqual(
    await Promise.all(protectedPaths.map(fingerprint)),
    before,
    "User app environments changed",
  );
}
