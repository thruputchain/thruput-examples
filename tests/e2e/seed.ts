// Runs only when explicitly invoked with `npm run test:seed`.
import assert from "node:assert/strict";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  addressFromHex,
  createGroundhogClient,
  HttpTransport,
  localnet,
  fromHex0x,
} from "@groundhogchain/client";
import { networkHash, sha256Hash } from "@groundhogchain/protocol";
import { ERC20 } from "@groundhogchain/client/contracts";
import { SwapFactory } from "../../apps/swap/src/contracts/generated/swap-factory.ts";
import { SwapHandler } from "../../apps/swap/src/contracts/generated/swap-handler.ts";
import { createGroundhogRegistrySource } from "../../apps/token-launchpad/server/chain.ts";
import { RegistryStore } from "../../apps/token-launchpad/server/store.ts";
import { RegistryIndexer } from "../../apps/token-launchpad/server/indexer.ts";
import { createRegistryHttpServer } from "../../apps/token-launchpad/server/http.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "groundhog-seed-"));
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
  ...(process.env.SEED_TEST_DEFAULT_OWNER === "1"
    ? {}
    : { SEED_RECIPIENT: `0x${"42".repeat(32)}` }),
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
  child.on("error", (error: Error) => {
    output += error.message;
  });
  child.stdout!.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr!.on("data", (data: Buffer) => {
    output += data.toString();
  });
  return { child, output: () => output };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 120_000;
  while (!(await check())) {
    assert.ok(!interrupted, "Seed test interrupted");
    assert.ok(
      Date.now() < deadline,
      "Timed out waiting for isolated test process",
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
let server: ReturnType<typeof createRegistryHttpServer> | undefined;
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
    process.env.GROUNDHOG_CLI ?? join(homedir(), ".cargo/bin/groundhog"),
    [
      "node",
      "--json",
      "--port",
      "0",
      "--dev-account-count",
      "0",
      "--hog-devnode-binary",
      process.env.GROUNDHOG_DEVNODE_BINARY ??
        join(homedir(), ".local/share/groundhog/hog-devnode/hog-devnode"),
      ...(process.env.GROUNDHOG_E2E_HOGD_PROTOCOL
        ? ["--hogd-protocol", process.env.GROUNDHOG_E2E_HOGD_PROTOCOL]
        : []),
    ],
  );
  let startup:
    | {
        ok: boolean;
        data: { rpc_url: string; runtime_manifest: { path: string } };
      }
    | undefined;
  await until(() => {
    assert.equal(
      node.child.exitCode,
      null,
      `Isolated node exited during startup: ${node.output().replace(/(?:0x)?[0-9a-fA-F]{64}/g, "[hex32]")}`,
    );
    try {
      const text = node.output();
      startup = JSON.parse(text.slice(text.indexOf("{")));
    } catch {
      return false;
    }
    return startup?.ok === true;
  });
  Object.assign(env, {
    GROUNDHOG_RPC_URL: startup!.data.rpc_url,
    GROUNDHOG_RUNTIME_MANIFEST: startup!.data.runtime_manifest.path,
  });
  stage = "infrastructure setup";
  for (const [app, prefix] of [
    ["swap", "SWAP"],
    ["token-launchpad", "LAUNCHPAD"],
  ]) {
    Object.assign(env, {
      [`${prefix}_ARTIFACT_ROOT`]:
        process.env.SEED_TEST_ARTIFACT_ROOT ?? join(root, "target/groundhog"),
      [`${prefix}_APP_ENV`]: join(work, `${prefix}.env`),
      [`${prefix}_APP_PUBLIC_DIR`]: join(work, `${prefix}/public`),
    });
    await run(app!, "setup-local");
  }
  const launch = parseEnv(await readFile(env.LAUNCHPAD_APP_ENV!, "utf8"));
  const swap = parseEnv(await readFile(env.SWAP_APP_ENV!, "utf8"));
  const scope = {
    networkId: launch.VITE_GROUNDHOG_NETWORK_ID!.slice(2),
    factoryAddress: launch.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!,
    tokenCodeHash: launch.VITE_STANDARD_TOKEN_HASH!,
  };
  const source = await createGroundhogRegistrySource({
    rpcUrl: new URL(env.GROUNDHOG_RPC_URL!),
    scope,
  });
  async function startRegistry() {
    store = new RegistryStore(join(work, "registry.sqlite"), scope);
    indexer = new RegistryIndexer(store, source, {
      pageSize: 200,
      syncIntervalMs: 1_000,
    });
    server = createRegistryHttpServer(store, indexer);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    env.LAUNCHPAD_REGISTRY_URL = `http://127.0.0.1:${address.port}`;
    indexer.start();
    await indexer.sync();
    assert.equal(store.getStatus().syncState, "idle");
    assert.equal(store.getStatus().lastError, null);
  }
  await startRegistry();
  const client = await createGroundhogClient({
    cluster: localnet({
      rpcUrl: env.GROUNDHOG_RPC_URL!,
      networkHash: networkHash(
        sha256Hash(fromHex0x(launch.VITE_GROUNDHOG_NETWORK_ID!)),
      ),
    }),
    transport: new HttpTransport(env.GROUNDHOG_RPC_URL!),
  });
  const factory = addressFromHex(swap.VITE_SWAP_FACTORY_ADDRESS!);
  const count = async () =>
    (await SwapFactory.v0_1.allPairsLength.view({ client, contract: factory }))
      .value;
  assert.equal(await count(), 0n);
  assert.equal(store!.getStatus().tokenCount, 0);
  stage =
    "reject a router initialized for another factory before any seed writes";
  const otherSetup = join(work, "OTHER-SWAP.env");
  await run("swap", "setup-local", { SWAP_APP_ENV: otherSetup });
  const other = parseEnv(await readFile(otherSetup, "utf8"));
  const tipBeforeMismatch = (await client.getChainTip()).height;
  const mismatchedRouter = {
    VITE_SWAP_ROUTER_ADDRESS: other.VITE_SWAP_ROUTER_ADDRESS!,
  };
  await run("swap", "seed-pools", mismatchedRouter, 1);
  assert.equal((await client.getChainTip()).height, tipBeforeMismatch);
  await assert.rejects(readdir(env.SEED_STATE_DIR!), { code: "ENOENT" });
  assert.equal(await count(), 0n);
  assert.equal(store!.getStatus().tokenCount, 0);
  stage = "token and pool seed commands";
  // Token seeding must not read Swap configuration or require its contracts.
  await run("token-launchpad", "seed-tokens", {
    SWAP_APP_ENV: join(work, "absent-swap.env"),
  });
  await run("swap", "seed-pools");
  const [scopeDirectory] = await readdir(env.SEED_STATE_DIR!);
  const manifestPath = join(
    env.SEED_STATE_DIR!,
    scopeDirectory!,
    "manifest.json",
  );
  const original = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(original) as {
    signer: string;
    recipient: string;
    tokens: { address: string }[];
    pool: { handler: string; liquidityToken: string };
  };
  assert.equal(
    (await stat(join(env.SEED_STATE_DIR!, scopeDirectory!, "signer.key")))
      .mode & 0o777,
    0o600,
  );
  assert.equal(store!.getStatus().tokenCount, 2);
  assert.equal(await count(), 1n);
  for (const token of manifest.tokens) {
    assert.equal(
      (
        await ERC20.v0_1.getBalanceOf.view({
          client,
          contract: addressFromHex(token.address),
          args: { addr: addressFromHex(manifest.recipient) },
        })
      ).value,
      999_000n * 1_000_000n,
    );
    assert.equal(
      (
        await ERC20.v0_1.getBalanceOf.view({
          client,
          contract: addressFromHex(token.address),
          args: { addr: addressFromHex(manifest.signer) },
        })
      ).value,
      manifest.recipient === manifest.signer ? 999_000n * 1_000_000n : 0n,
    );
  }
  const pool = (
    await SwapHandler.v0_1.poolState.view({
      client,
      contract: addressFromHex(manifest.pool.handler),
    })
  ).value;
  assert.deepEqual(pool.reserves, [1_000_000_000n, 1_000_000_000n]);
  assert.ok(
    (
      await ERC20.v0_1.getBalanceOf.view({
        client,
        contract: addressFromHex(manifest.pool.liquidityToken),
        args: { addr: addressFromHex(manifest.recipient) },
      })
    ).value > 0n,
  );
  stage = "restart and rerun";
  for (const overrides of [
    { SEED_RECIPIENT: `0x${"43".repeat(32)}` },
    { VITE_GROUNDHOG_NETWORK_ID: `0x${"43".repeat(32)}` },
    { VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"43".repeat(32)}` },
  ])
    await run("token-launchpad", "seed-tokens", overrides, 1);
  assert.equal(await readFile(manifestPath, "utf8"), original);
  await indexer!.stop();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  store!.close();
  await startRegistry();
  await run("token-launchpad", "seed-tokens");
  await run("swap", "seed-pools");
  assert.equal(await readFile(manifestPath, "utf8"), original);
  assert.equal(await count(), 1n);
  assert.equal(store!.getStatus().tokenCount, 2);
  console.log(
    `PASS: canonical indexing, recipient balances/LP, exact reserves, rerun without new transactions. Evidence: ${work}`,
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
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  store?.close();
  await processGroups.stopAll();
  assert.deepEqual(
    await Promise.all(protectedPaths.map(fingerprint)),
    before,
    "User app environments changed",
  );
}
