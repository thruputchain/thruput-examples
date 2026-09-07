import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  lstat,
  readlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  browserJourney,
  productionSmoke,
  scopeSmoke,
} from "./cross-app-browser.mjs";

const swap = fileURLToPath(new URL("..", import.meta.url));
const launchpad = fileURLToPath(
  new URL("../../token-launchpad", import.meta.url),
);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const cli = process.env.GROUNDHOG_CLI;
const devnode = process.env.GROUNDHOG_DEVNODE_BINARY;
assert.ok(cli && devnode, "Set GROUNDHOG_CLI and GROUNDHOG_DEVNODE_BINARY");
const work = await mkdtemp(`${tmpdir()}/groundhog-cross-app-`);
const children = new Set();
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(VITE_|GROUNDHOG_DEV_|TOKEN_DISCOVERY_|TOKEN_REGISTRY_|POOL_REGISTRY_|RAILWAY_)/.test(
        key,
      ),
  ),
);
Object.assign(env, {
  XDG_CONFIG_HOME: `${work}/config`,
  XDG_CACHE_HOME: `${work}/cache`,
  XDG_DATA_HOME: `${work}/data`,
  GROUNDHOG_CLI: cli,
});
let browser;
let stage = "startup";
const logs = new Map();
const preservedPaths = [
  `${swap}/.env.local`,
  `${launchpad}/.env.local`,
  `${swap}/.groundhog-config/groundhog/config.toml`,
];
async function fingerprint(path) {
  try {
    const stat = await lstat(path);
    return [
      stat.mode,
      stat.mtimeMs,
      stat.isSymbolicLink() ? await readlink(path) : null,
      await readFile(path)
        .then((b) => createHash("sha256").update(b).digest("hex"))
        .catch(() => null),
    ];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const preserved = await Promise.all(preservedPaths.map(fingerprint));
function start(command, args, cwd, extra = {}) {
  assert.equal(interrupted, false, "Acceptance interrupted");
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...extra },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-200_000);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-200_000);
  });
  logs.set(child, () => output);
  child.on("error", () => {});
  return child;
}
async function stop(child) {
  if (!child?.pid || !children.has(child)) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(timer);
      resolve();
    }
  });
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  children.delete(child);
}
async function run(command, args, cwd, extra) {
  const child = start(command, args, cwd, extra);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  children.delete(child);
  const timedOutHash = logs
    .get(child)()
    .match(/Timed out waiting for transaction receipt (0x[0-9a-f]{64})/)?.[1];
  if (timedOutHash) {
    const response = await fetch(env.GROUNDHOG_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_getTransactionStatus",
        params: [timedOutHash],
      }),
    });
    console.error(
      `Timed-out transaction status: ${redact(await response.text())}`,
    );
  }
  assert.equal(
    code,
    0,
    `${stage}: ${command} ${args.join(" ")}\n${redact(logs.get(child)())}`,
  );
  return logs.get(child)();
}
let secrets = [];
function redact(text) {
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(/0x[0-9a-fA-F]{64}/g, "[hex]");
}
async function until(check, message, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.equal(interrupted, false, "Acceptance interrupted");
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${message}`);
}
async function ready(origin, child) {
  await until(async () => {
    assert.equal(child.exitCode, null, redact(logs.get(child)()));
    return fetch(origin)
      .then((r) => r.ok)
      .catch(() => false);
  }, origin);
}
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
async function scan(directory, forbidden) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scan(path, forbidden);
    else {
      const contents = await readFile(path);
      for (const value of forbidden)
        assert.ok(
          !contents.includes(Buffer.from(value)),
          `Secret/upstream leaked into ${entry.name}`,
        );
    }
  }
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    void Promise.all([...children].map(stop)).then(() => browser?.close());
  });
try {
  console.log(
    `TOOLS: ${(await run(cli, ["--version"], root)).trim()}; ${(await run(devnode, ["--version"], root)).trim()}; Node ${process.version}`,
  );
  const node = start(
    cli,
    [
      "node",
      "--json",
      "--port",
      "0",
      "--dev-account-count",
      "3",
      "--dev-account-hog",
      "100",
      "--hog-devnode-binary",
      devnode,
      "--hogd-protocol",
      process.env.GROUNDHOG_E2E_HOGD_PROTOCOL || "hogp/4166df9d6a5411d",
    ],
    root,
  );
  let startup;
  await until(() => {
    assert.equal(node.exitCode, null, redact(logs.get(node)()));
    const text = logs.get(node)();
    try {
      startup = JSON.parse(text.slice(text.indexOf("{")));
    } catch {
      return false;
    }
    return startup.ok === true;
  }, "node runtime manifest");
  Object.assign(env, {
    GROUNDHOG_RPC_URL: startup.data.rpc_url,
    GROUNDHOG_RUNTIME_MANIFEST: startup.data.runtime_manifest.path,
  });
  const manifest = JSON.parse(
    await readFile(env.GROUNDHOG_RUNTIME_MANIFEST, "utf8"),
  );
  assert.equal(manifest.protocol, "hogp/4166df9d6a5411d");
  console.log(`PROTOCOL: ${manifest.protocol}`);
  secrets.push(manifest.bootstrapAccountDerivation.seed);
  stage = "sequential contract builds and provisioning";
  console.log(stage);
  for (const name of [
    "erc20",
    "swap-factory",
    "swap-router",
    "swap-handler",
    "swap-driver",
    "standard-token",
    "standard-token-factory",
  ]) {
    await run(
      cli,
      [
        "build",
        "-p",
        name,
        "--",
        ...(name === "erc20" ? ["-F", "metadata"] : ["--locked"]),
      ],
      root,
    );
  }
  await run(`${swap}/node_modules/.bin/tsx`, ["scripts/setup-local.ts"], swap, {
    SWAP_ARTIFACT_ROOT: `${root}/target/groundhog`,
    SWAP_APP_ENV: `${work}/swap.env`,
    SWAP_CLI_CONFIG_HOME: `${work}/swap-cli`,
  });
  await run(
    `${launchpad}/node_modules/.bin/tsx`,
    ["scripts/setup-local.ts"],
    launchpad,
    {
      LAUNCHPAD_ARTIFACT_ROOT: `${root}/target/groundhog`,
      LAUNCHPAD_APP_ENV: `${work}/launchpad.env`,
    },
  );
  const s = parseEnv(await readFile(`${work}/swap.env`, "utf8"));
  const l = parseEnv(await readFile(`${work}/launchpad.env`, "utf8"));
  for (const app of [s, l]) {
    assert.equal(
      app.VITE_GROUNDHOG_NETWORK_ID.replace(/^0x/, ""),
      manifest.networkHash.replace(/^0x/, ""),
    );
    secrets.push(
      ...JSON.parse(app.GROUNDHOG_DEV_PERSONAS).map((p) => p.privateKey),
    );
  }
  const [sp, lp, srp, lrp] = await Promise.all([
    port(),
    port(),
    port(),
    port(),
  ]);
  assert.equal(new Set([sp, lp, srp, lrp]).size, 4);
  const so = `http://127.0.0.1:${sp}`,
    lo = `http://127.0.0.1:${lp}`;
  const sr = `http://127.0.0.1:${srp}`,
    lr = `http://127.0.0.1:${lrp}`;
  Object.assign(s, {
    VITE_POOL_REGISTRY_ENABLED: "false",
    VITE_TOKEN_DISCOVERY_ENABLED: "true",
    VITE_STANDARD_TOKEN_FACTORY_ADDRESS: l.VITE_STANDARD_TOKEN_FACTORY_ADDRESS,
    VITE_STANDARD_TOKEN_HASH: l.VITE_STANDARD_TOKEN_HASH,
    TOKEN_DISCOVERY_UPSTREAM_ORIGIN: lr,
  });
  Object.assign(l, {
    VITE_TOKEN_REGISTRY_ENABLED: "false",
    VITE_SWAP_APP_URL: so,
  });
  // Process env wins over existing .env.local. Empty optionals prevent accidental
  // reuse; neither user env files nor generated CLI config are written.
  const prod = (app, extra) => ({
    ...app,
    GROUNDHOG_DEV_PERSONAS: "",
    GROUNDHOG_DEV_PRIVATE_KEY: "",
    ...extra,
  });
  const ps = prod(s, {
    VITE_POOL_REGISTRY_ENABLED: "true",
    PORT: String(srp),
    POOL_REGISTRY_DB_PATH: `${work}/pools.sqlite`,
  });
  const pl = prod(l, {
    VITE_TOKEN_REGISTRY_ENABLED: "true",
    PORT: String(lrp),
    TOKEN_REGISTRY_DB_PATH: `${work}/tokens.sqlite`,
    TOKEN_REGISTRY_SYNC_INTERVAL_MS: "86400000",
  });
  stage = "production builds";
  for (const [app, settings] of [
    [swap, ps],
    [launchpad, pl],
  ]) {
    await run("npm", ["run", "build:production"], app, settings);
    await scan(`${app}/dist`, [...secrets, lr]);
  }
  let registry = start(
    `${launchpad}/node_modules/.bin/tsx`,
    ["server/main.ts"],
    launchpad,
    pl,
  );
  const poolRegistry = start(
    `${swap}/node_modules/.bin/tsx`,
    ["server/main.ts"],
    swap,
    ps,
  );
  await ready(lr, registry);
  await ready(sr, poolRegistry);
  const sv = start(
    `${swap}/node_modules/.bin/vite`,
    ["--host", "127.0.0.1", "--port", String(sp), "--strictPort"],
    swap,
    s,
  );
  const lv = start(
    `${launchpad}/node_modules/.bin/vite`,
    ["--host", "127.0.0.1", "--port", String(lp), "--strictPort"],
    launchpad,
    l,
  );
  await ready(so, sv);
  await ready(lo, lv);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  console.log(
    `BROWSER: Chromium ${browser.version()}; NETWORK: ${manifest.networkHash}`,
  );
  stage = "live browser handoff and pool creation";
  assert.equal(interrupted, false, "Acceptance interrupted");
  const evidence = await browserJourney({
    browser,
    so,
    lo,
    s,
    l,
    until,
    catchUp: async () => {
      await stop(registry);
      registry = start(
        `${launchpad}/node_modules/.bin/tsx`,
        ["server/main.ts"],
        launchpad,
        pl,
      );
      await ready(lr, registry);
    },
    outage: () => stop(registry),
  });
  await writeFile(`${work}/evidence.json`, JSON.stringify(evidence), {
    mode: 0o600,
  });
  stage = "independent on-chain mapping, reserves and LP reads";
  console.log(
    await run(
      `${swap}/node_modules/.bin/tsx`,
      ["scripts/cross-app-chain.ts", `${work}/evidence.json`],
      swap,
      s,
    ),
  );
  await stop(registry);
  registry = start(
    `${launchpad}/node_modules/.bin/tsx`,
    ["server/main.ts"],
    launchpad,
    pl,
  );
  await ready(lr, registry);
  stage = "live registry scope and RPC network mismatch";
  for (const kind of ["registry", "network"]) {
    const p = await port();
    const origin = `http://127.0.0.1:${p}`;
    const fault = start(
      `${swap}/node_modules/.bin/vite`,
      ["--host", "127.0.0.1", "--port", String(p), "--strictPort"],
      swap,
      {
        ...s,
        ...(kind === "registry"
          ? { VITE_STANDARD_TOKEN_FACTORY_ADDRESS: s.VITE_SWAP_FACTORY_ADDRESS }
          : { VITE_GROUNDHOG_NETWORK_ID: "ff".repeat(32) }),
      },
    );
    try {
      await ready(origin, fault);
      await scopeSmoke({ browser, origin, kind, evidence });
    } finally {
      await stop(fault);
    }
  }
  stage = "both production HTTP and browser security";
  await productionSmoke({ browser, sr, lr, evidence });
  stage = "full suites, typechecks and production rebuilds after acceptance";
  for (const [app, settings] of [
    [swap, ps],
    [launchpad, pl],
  ]) {
    for (const command of ["test", "typecheck", "build:production"]) {
      const output = await run("npm", ["run", command], app, settings);
      console.log(
        `${basename(app)} ${command}: PASS\n${output.match(/Test Files[^\n]*\n[^\n]*/)?.[0] || ""}`,
      );
    }
    await scan(`${app}/dist`, [...secrets, lr]);
  }
  assert.equal(interrupted, false);
  console.log(`PASS cross-app acceptance: ${JSON.stringify(evidence)}`);
} catch (error) {
  console.error(`FAIL at ${stage}: ${redact(error.stack || String(error))}`);
  for (const context of browser?.contexts() || [])
    for (const page of context.pages()) {
      console.error(
        `Browser state: ${redact(
          await page
            .locator("body")
            .innerText()
            .catch(() => "unavailable"),
        )}`,
      );
    }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await Promise.all([...children].map(stop));
  await rm(work, { recursive: true, force: true });
  assert.deepEqual(
    await Promise.all(preservedPaths.map(fingerprint)),
    preserved,
    "User env/config changed during acceptance",
  );
  console.log(
    "CLEANUP: owned process groups and temporary state removed; both .env.local files/symlinks and generated CLI config unchanged",
  );
}
