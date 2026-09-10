import assert from "node:assert/strict";
import { OwnedProcessGroups } from "./wallet-acceptance/process-groups.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  cp,
  symlink,
  readdir,
} from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const swap = `${root}/apps/swap`,
  launchpad = `${root}/apps/token-launchpad`;
const extension = `${root}/apps/wallet-extension`;
const require = createRequire(`${extension}/package.json`);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = createRequire(`${swap}/package.json`)("playwright-core"));
}
const work = await mkdtemp("/tmp/opencode/wallet-acceptance-");
await mkdir(`${work}/evidence`, { mode: 0o700 });
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH"].includes(key),
  ),
);
Object.assign(env, {
  XDG_CONFIG_HOME: `${work}/config`,
  XDG_CACHE_HOME: `${work}/cache`,
  XDG_DATA_HOME: `${work}/data`,
  TMPDIR: work,
});
const cli = process.env.GROUNDHOG_CLI || `${homedir()}/.cargo/bin/groundhog`;
const devnode =
  process.env.GROUNDHOG_DEVNODE_BINARY ||
  `${homedir()}/.local/share/groundhog/hog-devnode/hog-devnode`;
const processGroups = new OwnedProcessGroups(),
  logs = new Map(),
  secrets = [randomBytes(24).toString("hex")];
const evidence = {
  startedAt: new Date().toISOString(),
  checks: [],
  approvals: [],
  tokens: [],
  blockers: [],
  extensionRpcRequests: 0,
};
let context,
  proxy,
  stage = "startup",
  interrupted = false;
const protectedPaths = [swap, launchpad].map((app) => `${app}/.env.local`);
const fingerprint = async (path) =>
  readFile(path)
    .then((b) => createHash("sha256").update(b).digest("hex"))
    .catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
const before = await Promise.all(protectedPaths.map(fingerprint));
const devnetRpc = "http://44.236.180.135:8545";
let devnetAllowed = false;
const browserOrigins = new Set();
function redact(text) {
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(/0x[0-9a-fA-F]{64}/g, "[hex32]");
}
function start(command, args, cwd = root, extra = {}, exactEnv = false) {
  assert.ok(!interrupted, "Interrupted");
  const child = processGroups.spawn(command, args, {
    cwd,
    env: exactEnv ? extra : { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      output = (output + b).slice(-200000);
    });
  child.on("error", (e) => {
    output += e.message;
  });
  logs.set(child, () => output);
  return child;
}
async function until(check, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.ok(!interrupted, "Interrupted");
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out: ${description}`);
}
async function run(command, args, cwd, extra, exactEnv = false) {
  const child = start(command, args, cwd, extra, exactEnv);
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    command,
    180000,
  );
  assert.equal(child.exitCode, 0, redact(logs.get(child)()));
  return logs.get(child)();
}
async function stop(child) {
  await processGroups.stop(child);
}
function interrupt() {
  interrupted = true;
  void context?.close().catch(() => {});
  void processGroups.stopAll().catch((error) => {
    console.error(`Interrupted cleanup: ${redact(error.message)}`);
  });
}
const timer = setTimeout(() => {
  interrupt();
}, 15 * 60000);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, interrupt);
function check(name) {
  evidence.checks.push(name);
  console.log(`PASS ${name}`);
}
async function controlledEnvironment(app, settings, mode) {
  // loadEnv merges process env last. Explicitly blank every user-file key,
  // including keys not present in this run's generated infrastructure env.
  const controlled = {};
  for (const name of [
    ".env",
    ".env.local",
    `.env.${mode}`,
    `.env.${mode}.local`,
  ]) {
    const values = await readFile(`${app}/${name}`, "utf8")
      .then(parseEnv)
      .catch((e) => {
        if (e.code === "ENOENT") return {};
        throw e;
      });
    for (const key of Object.keys(values)) controlled[key] = "";
  }
  return Object.assign(controlled, settings);
}
async function appServer(app, settings, publicDir) {
  const controlled = await controlledEnvironment(
    app,
    {
      ...settings,
      VITE_POOL_REGISTRY_ENABLED: "false",
      VITE_TOKEN_REGISTRY_ENABLED: "false",
      VITE_TOKEN_DISCOVERY_ENABLED: "false",
    },
    "wallet-acceptance",
  );
  const child = start(
    process.execPath,
    [
      `${root}/scripts/wallet-acceptance/vite.mjs`,
      app,
      publicDir,
      `${publicDir}/../vite-cache`,
    ],
    app,
    controlled,
  );
  let origin;
  await until(() => {
    assert.equal(child.exitCode, null, redact(logs.get(child)()));
    origin = logs
      .get(child)()
      .match(/ACCEPTANCE_ORIGIN=(http:\/\/[^\s]+)/)?.[1];
    return origin;
  }, "Vite server");
  return origin.replace(/\/$/, "");
}
async function unusedPort() {
  const server = netServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function scanBuild(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scanBuild(path);
    else {
      const bytes = await readFile(path);
      for (const secret of [...secrets, env.GROUNDHOG_RPC_URL])
        assert.ok(
          !bytes.includes(Buffer.from(secret)),
          `Secret or raw upstream URL in production asset ${entry.name}`,
        );
      assert.ok(!/^\.env/.test(entry.name), "Env file in browser output");
    }
  }
}
async function productionSmoke(app, prefix, settings, context) {
  const directory = `${work}/production/${prefix}`;
  const publicDir = `${work}/${prefix}/public`;
  const hash =
    settings[
      prefix === "SWAP" ? "VITE_POOL_TOKEN_HASH" : "VITE_STANDARD_TOKEN_HASH"
    ];
  const filename = `contract-artifacts/${hash}.json`;
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const runtime = {
    ...settings,
    VITE_TOKEN_DISCOVERY_ENABLED: "false",
    VITE_POOL_REGISTRY_ENABLED: "true",
    VITE_TOKEN_REGISTRY_ENABLED: "true",
    PORT: String(port),
    [`${prefix === "SWAP" ? "POOL" : "TOKEN"}_REGISTRY_DB_PATH`]: `${directory}/registry.sqlite`,
  };
  await mkdir(directory, { recursive: true });
  // Unchanged production entrypoints resolve ../dist. Copy only code, never
  // user env files or databases, and share installed dependencies read-only.
  for (const path of ["server", "src", "package.json", "tsconfig.json"])
    await cp(`${app}/${path}`, `${directory}/${path}`, { recursive: true });
  await symlink(`${app}/node_modules`, `${directory}/node_modules`, "dir");
  const buildArgs = [
    `${root}/scripts/wallet-acceptance/build-production.mjs`,
    app,
    publicDir,
    `${directory}/dist`,
  ];
  const buildEnv = await controlledEnvironment(app, runtime, "production");
  // Positive build runs the app's production artifact validators.
  const publicBuildEnv = Object.fromEntries(
    Object.entries({ ...env, ...buildEnv }).filter(
      ([key]) => !key.startsWith("GROUNDHOG_"),
    ),
  );
  await run(process.execPath, buildArgs, app, publicBuildEnv, true);
  await scanBuild(`${directory}/dist`);
  const artifact = await readFile(`${publicDir}/${filename}`);
  assert.deepEqual(await readFile(`${directory}/dist/${filename}`), artifact);
  // Both real entrypoints must refuse startup before the required asset exists.
  await rm(`${directory}/dist/${filename}`);
  const entrypoint = [`${directory}/server/main.ts`];
  const serverEnv = Object.fromEntries(
    Object.entries({ ...env, ...runtime }).filter(
      ([key]) => !key.startsWith("GROUNDHOG_"),
    ),
  );
  for (const key of Object.keys(serverEnv))
    assert.ok(
      !/PRIVATE_KEY|MNEMONIC|PASSWORD|SECRET|PERSONAS/.test(key),
      "Production environment must not include signing credentials",
    );
  await assert.rejects(
    run(`${app}/node_modules/.bin/tsx`, entrypoint, directory, serverEnv, true),
    /artifact|failed to start/i,
  );
  await writeFile(`${directory}/dist/${filename}`, artifact);
  const child = start(
    `${app}/node_modules/.bin/tsx`,
    entrypoint,
    directory,
    serverEnv,
    true,
  );
  await until(
    async () => {
      assert.equal(child.exitCode, null, redact(logs.get(child)()));
      return fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
    },
    `${prefix} production readiness`,
    20000,
  );
  browserOrigins.add(origin);
  const response = await fetch(`${origin}/${filename}`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), artifact);
  const manifest = await fetch(`${origin}/groundhog-public-config.json`, {
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json());
  assert.equal(
    manifest[
      prefix === "SWAP" ? "VITE_POOL_TOKEN_HASH" : "VITE_STANDARD_TOKEN_HASH"
    ],
    hash,
  );
  for (const method of [
    "groundhog_networkInfo",
    "groundhog_sendRawTransaction",
    "groundhog_requestAirdrop",
  ]) {
    const reply = await fetch(`${origin}/groundhog-rpc`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    });
    assert.equal(reply.status, method === "groundhog_networkInfo" ? 200 : 403);
    if (method === "groundhog_networkInfo")
      assert.equal((await reply.json()).result.networkHash, evidence.network);
  }
  const collection = prefix === "SWAP" ? "pools" : "tokens";
  let rows;
  await until(
    async () => {
      const reply = await fetch(`${origin}/api/${collection}`, {
        signal: AbortSignal.timeout(3000),
      }).then((r) => r.json());
      rows = reply[collection];
      return rows?.length === (prefix === "SWAP" ? 1 : 2);
    },
    `${prefix} production registry indexing`,
    20000,
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/${prefix === "SWAP" ? "pools" : "tokens"}`);
  await page
    .getByRole("button", {
      name: "Connect Groundhog Wallet",
      exact: true,
    })
    .waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${work}/evidence/production-${prefix}.png` });
  await page.close();
  evidence.production ??= [];
  evidence.production.push({
    app: prefix,
    origin,
    artifact: filename,
    indexedRows: rows.length,
    missingArtifactRejected: true,
    signingEnvironmentKeys: [],
  });
  check(
    `${prefix} real production build/start, immutable artifact, indexed reads, credential-free environment and write rejection`,
  );
  browserOrigins.delete(origin);
  await stop(child);
}
async function connect(page) {
  const button = page.getByRole("button", {
    name: "Connect Groundhog Wallet",
    exact: true,
  });
  await page.getByRole("button", { name: /^Connect / }).waitFor();
  const picker = page.getByLabel("Wallet provider", { exact: true });
  if (await picker.count()) {
    await picker.selectOption({ label: "Groundhog Wallet" });
  }
  await button.click();
  if (
    await page
      .getByRole("region", { name: "Wallet connection", exact: true })
      .count()
  ) {
    await page.getByLabel("Wallet account", { exact: true }).waitFor();
  } else {
    await until(
      async () => !(await button.count()),
      "wallet connection",
    );
  }
}
try {
  console.log(`Evidence: ${work}/evidence`);
  evidence.tools = {
    node: process.version,
    cli: (await run(cli, ["--version"])).trim(),
    devnode: (await run(devnode, ["--version"])).trim(),
  };
  const node = start(cli, [
    "node",
    "--json",
    "--port",
    "0",
    "--dev-account-count",
    "0",
    "--hog-devnode-binary",
    devnode,
    ...(process.env.GROUNDHOG_E2E_HOGD_PROTOCOL
      ? ["--hogd-protocol", process.env.GROUNDHOG_E2E_HOGD_PROTOCOL]
      : []),
  ]);
  let startup;
  await until(() => {
    assert.equal(node.exitCode, null, redact(logs.get(node)()));
    try {
      const text = logs.get(node)();
      startup = JSON.parse(text.slice(text.indexOf("{")));
    } catch {
      return false;
    }
    return startup.ok;
  }, "node manifest");
  Object.assign(env, {
    GROUNDHOG_RPC_URL: startup.data.rpc_url,
    GROUNDHOG_RUNTIME_MANIFEST: startup.data.runtime_manifest.path,
  });
  const manifest = JSON.parse(
    await readFile(env.GROUNDHOG_RUNTIME_MANIFEST, "utf8"),
  );
  if (manifest.bootstrapAccountDerivation?.seed)
    secrets.push(manifest.bootstrapAccountDerivation.seed);
  evidence.network = `0x${manifest.networkHash.replace(/^0x/, "")}`;
  evidence.rpc = env.GROUNDHOG_RPC_URL;
  evidence.runtimeCosts = manifest.bootstrap?.storageCostModel;
  assert.ok(
    evidence.runtimeCosts,
    "Full runtime storage cost manifest is required",
  );
  stage = "infrastructure-only provisioning";
  for (const [app, prefix] of [
    [swap, "SWAP"],
    [launchpad, "LAUNCHPAD"],
  ]) {
    await run(`${app}/node_modules/.bin/tsx`, ["scripts/setup-local.ts"], app, {
      [`${prefix}_ARTIFACT_ROOT`]:
        process.env.WALLET_ACCEPTANCE_ARTIFACT_ROOT ||
        `${root}/target/groundhog`,
      [`${prefix}_APP_ENV`]: `${work}/${prefix}.env`,
      [`${prefix}_APP_PUBLIC_DIR`]: `${work}/${prefix}/public`,
    });
  }
  check("infrastructure setup without seeded tokens or pools");
  const s = parseEnv(await readFile(`${work}/SWAP.env`, "utf8"));
  const l = parseEnv(await readFile(`${work}/LAUNCHPAD.env`, "utf8"));
  for (const [prefix, hash] of [
    ["SWAP", s.VITE_POOL_TOKEN_HASH],
    ["LAUNCHPAD", l.VITE_STANDARD_TOKEN_HASH],
  ]) {
    assert.match(hash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(
      await readdir(`${work}/${prefix}/public/contract-artifacts`),
      [`${hash}.json`],
    );
  }
  check(
    "setup exports only immutable 0x-prefixed hash-named artifacts with validated full runtime costs",
  );
  await run(
    `${swap}/node_modules/.bin/tsx`,
    [`${root}/scripts/wallet-acceptance/chain.mts`, "empty"],
    swap,
    s,
  );
  check("independent chain read confirms zero factory pairs");
  const so = await appServer(swap, s, `${work}/SWAP/public`);
  const lo = await appServer(
    launchpad,
    { ...l, VITE_SWAP_APP_URL: so },
    `${work}/LAUNCHPAD/public`,
  );
  browserOrigins.add(so);
  browserOrigins.add(lo);
  // A real browser proxy also covers extension service-worker fetches, unlike
  // page-only Playwright routes. Never forward the fixed URL to the user's node.
  proxy = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (
      url.origin === "http://127.0.0.1:9545" ||
      url.origin === "http://localhost:9545"
    ) {
      evidence.extensionRpcRequests++;
      url = new URL(env.GROUNDHOG_RPC_URL);
    } else if (
      !browserOrigins.has(url.origin) &&
      !(devnetAllowed && url.origin === devnetRpc)
    ) {
      res.writeHead(403).end();
      return;
    }
    const upstream = httpRequest(
      url,
      {
        method: req.method,
        headers: { ...req.headers, host: url.host },
        timeout: 15000,
      },
      (reply) => {
        let diagnostic = "";
        reply.on("data", (chunk) => {
          if (diagnostic.length < 32000) diagnostic += chunk;
        });
        reply.on("end", () => {
          try {
            const error = JSON.parse(diagnostic).error;
            if (
              error &&
              (url.origin === new URL(env.GROUNDHOG_RPC_URL).origin ||
                url.origin === devnetRpc)
            ) {
              evidence.rpcErrors ??= [];
              evidence.rpcErrors.push({
                code: error.code,
                message: redact(String(error.message)).slice(0, 1000),
              });
            }
          } catch {}
        });
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.on("timeout", () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.on("connect", (_req, socket) => socket.destroy());
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  await cp(`${extension}/dist`, `${work}/extension`, { recursive: true });
  if (process.argv.includes("--build-extension"))
    await run(
      process.execPath,
      [
        `${root}/scripts/wallet-acceptance/build-extension.mjs`,
        extension,
        `${work}/extension`,
      ],
      extension,
    );
  evidence.extension = {
    rebuiltFromSource: process.argv.includes("--build-extension"),
    workerSha256: await fingerprint(`${work}/extension/worker.js`),
  };
  stage = "real extension onboarding";
  context = await chromium.launchPersistentContext(`${work}/profile`, {
    env,
    executablePath: process.env.CHROMIUM_PATH || "/usr/lib/chromium/chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${work}/extension`,
      `--load-extension=${work}/extension`,
      "--proxy-bypass-list=<-loopback>",
    ],
    proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
  });
  context.setDefaultTimeout(45000);
  evidence.tools.chromium = context.browser().version();
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  // URL.origin is "null" for extension URLs in Node.
  const extensionUrl = `chrome-extension://${worker.url().split("/")[2]}`;
  let rejectNext = false,
    approvalError;
  context.on("page", (page) => {
    void (async () => {
      await page
        .waitForURL((url) => url.searchParams.has("approval"), {
          timeout: 1000,
        })
        .catch(() => {});
      if (
        !page.url().startsWith(extensionUrl) ||
        !page.url().includes("approval=")
      )
        return;
      const origin = await page.locator(".origin").innerText();
      assert.ok([lo, so].includes(origin), "Unexpected approval origin");
      const reject = rejectNext;
      rejectNext = false;
      const signing = await page
        .getByRole("heading", { name: "Approve a signature?" })
        .count();
      if (signing)
        await page
          .locator(".review")
          .getByText(evidence.creator, { exact: true })
          .waitFor();
      evidence.approvals.push({
        origin,
        kind: signing ? "signature" : "connection",
        rejected: reject,
      });
      await page
        .getByRole("button", {
          name: reject ? "Reject" : signing ? "Sign only" : "Connect",
          exact: true,
        })
        .click()
        .catch((error) => {
          // The real popup closes itself during click dispatch. App/chain checks
          // below still require the requested decision to take effect.
          if (!page.isClosed()) throw error;
        });
    })().catch((e) => {
      approvalError = e;
    });
  });
  const wallet = await context.newPage();
  await wallet.goto(`${extensionUrl}/index.html`);
  await wallet
    .getByLabel("Password (at least 12 characters)", { exact: true })
    .fill(secrets[0]);
  await wallet.getByLabel("Confirm password", { exact: true }).fill(secrets[0]);
  await wallet
    .getByRole("button", { name: "Create encrypted wallet", exact: true })
    .click();
  await wallet.getByText("Recovery backup", { exact: true }).click();
  await wallet
    .getByLabel("Re-enter password", { exact: true })
    .fill(secrets[0]);
  await wallet
    .getByRole("button", { name: "Reveal recovery backup", exact: true })
    .click();
  await wallet.locator(".seed li").first().waitFor();
  assert.equal(await wallet.locator(".seed li").count(), 24);
  await wallet
    .getByRole("button", { name: "Hide backup", exact: true })
    .click();
  evidence.creator = await wallet
    .getByLabel("Account", { exact: true })
    .inputValue();
  await wallet.getByRole("button", { name: "Assets", exact: true }).click();
  await wallet
    .getByRole("button", { name: "Request test HOG", exact: true })
    .click();
  await wallet.getByText(/^Airdrop confirmed:/).waitFor();
  assert.ok(
    evidence.extensionRpcRequests > 0,
    "Extension RPC must use the isolated browser proxy",
  );
  check("fresh encrypted wallet, backup display and local test HOG airdrop");
  const page = await context.newPage();
  for (let i = 0; i < 2; i++) {
    stage = `launch token ${i + 1}`;
    await page.goto(`${lo}/create`);
    await connect(page);
    if (i)
      await page
        .getByRole("button", { name: "Create another token", exact: true })
        .click();
    const symbol = `${i ? "BET" : "ALP"}${randomBytes(2).toString("hex").toUpperCase()}`;
    for (const [label, value] of [
      ["Token name", `Acceptance ${symbol}`],
      ["Symbol", symbol],
      ["Decimals", "6"],
      ["Initial supply", "1000000"],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
    await page
      .getByRole("button", { name: "Review launch", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Launch token", exact: true })
      .click();
    await until(async () => {
      if (approvalError) throw approvalError;
      const error = page.getByText(
        "The funding transaction committed, but the required reserve is not available.",
        { exact: true },
      );
      if (await error.count()) throw new Error(await error.innerText());
      return page
        .getByText(
          "Receipt, events, metadata, supply, and holder balance match this launch.",
          { exact: true },
        )
        .isVisible();
    }, "complete launch verification");
    if (approvalError) throw approvalError;
    const launches = await page.evaluate(() =>
      Object.values(localStorage).flatMap((v) => {
        try {
          const x = JSON.parse(v);
          return x?.verification?.status === "complete" ? [x] : [];
        } catch {
          return [];
        }
      }),
    );
    const launch = launches.find(
      (x) => !evidence.tokens.some((t) => t.address === x.createdAddressHex),
    );
    assert.ok(launch, "Verified saved launch");
    evidence.tokens.push({ address: launch.createdAddressHex, symbol });
    check(
      `token ${i + 1} complete receipt/event/metadata/supply/holder verification`,
    );
    await page.screenshot({ path: `${work}/evidence/token-${i + 1}.png` });
  }
  stage = "empty factory and pool creation";
  evidence.token = evidence.tokens[0].address;
  evidence.counter = evidence.tokens[1].address;
  await page.goto(`${so}/pools/new`);
  await connect(page);
  await page.getByRole("link", { name: "Create Pool", exact: true }).click();
  const addresses = page.getByLabel("Contract address", { exact: true });
  for (let i = 0; i < 2; i++) {
    await addresses.nth(i).fill(evidence.tokens[i].address);
    await page
      .getByText(`Live symbol: ${evidence.tokens[i].symbol}`, { exact: true })
      .waitFor();
    await page.getByLabel("Initial amount", { exact: true }).nth(i).fill("10");
  }
  assert.equal(
    await page
      .getByRole("switch", { name: "Manual queue processing" })
      .isChecked(),
    false,
  );
  await page.getByRole("button", { name: "Review pool", exact: true }).click();
  await page.getByRole("button", { name: "Create pool", exact: true }).click();
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/pools/") && url.pathname !== "/pools/new",
    { timeout: 180000 },
  );
  await page.getByText("Your LP share", { exact: true }).waitFor();
  const workflow = await page.evaluate(() =>
    Object.values(localStorage)
      .map((v) => {
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      })
      .find((v) => v?.steps?.createPool && v.status === "executed"),
  );
  assert.ok(workflow?.pool);
  evidence.pool = workflow.pool;
  check(
    "two launched tokens form first pool through popup-approved auto-cranked workflow",
  );
  await writeFile(
    `${work}/evidence/chain-input.json`,
    JSON.stringify(evidence),
    { mode: 0o600 },
  );
  const snapshot = async (recipient) =>
    JSON.parse(
      await run(
        `${swap}/node_modules/.bin/tsx`,
        [
          `${root}/scripts/wallet-acceptance/chain.mts`,
          `${work}/evidence/chain-input.json`,
          ...(recipient ? [recipient] : []),
        ],
        swap,
        s,
      ),
    );
  evidence.initialPool = await snapshot();
  assert.equal(evidence.initialPool.reserve0, "10000000");
  assert.equal(evidence.initialPool.reserve1, "10000000");
  check(
    "independent factory mapping, reverse pair, exact reserves and positive LP balance",
  );
  await page.screenshot({ path: `${work}/evidence/pool.png` });
  await page.reload();
  await connect(page);
  await page.getByText("Your LP share", { exact: true }).waitFor();
  check("reload and reconnect recover the created pool");
  stage = "swap";
  const poolUrl = page.url();
  await page.getByRole("link", { name: "Swap", exact: true }).click();
  await page.getByLabel("YOU PAY", { exact: true }).fill("1");
  rejectNext = true;
  await page.getByRole("button", { name: /^(Approve & swap|Swap)$/ }).click();
  await page.getByText("User rejected the request", { exact: true }).waitFor();
  assert.deepEqual(await snapshot(), evidence.initialPool);
  check(
    "rejected swap signature leaves reserves, LP and holder balances unchanged",
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByText("Executed", { exact: true })
    .first()
    .waitFor({ timeout: 120000 });
  evidence.afterSwap = await snapshot();
  assert.notEqual(evidence.afterSwap.reserve0, evidence.initialPool.reserve0);
  assert.notEqual(evidence.afterSwap.reserve1, evidence.initialPool.reserve1);
  assert.equal(evidence.afterSwap.lp, evidence.initialPool.lp);
  check(
    "popup-approved swap auto-cranks and changes reserves without changing LP",
  );
  await page.screenshot({ path: `${work}/evidence/swap.png` });
  stage = "add liquidity";
  await page.goto(`${poolUrl}/liquidity`);
  await connect(page);
  await page
    .getByRole("link", { name: "Manage liquidity", exact: true })
    .click();
  await page.locator("#liquidity-token-a-amount").fill("1");
  await page
    .getByRole("button", { name: "Add liquidity", exact: true })
    .click();
  await page
    .getByText(/Recipient delivery verified/)
    .waitFor({ timeout: 120000 });
  evidence.afterAdd = await snapshot();
  assert.ok(BigInt(evidence.afterAdd.lp) > BigInt(evidence.afterSwap.lp));
  assert.ok(
    BigInt(evidence.afterAdd.reserve0) > BigInt(evidence.afterSwap.reserve0),
  );
  assert.ok(
    BigInt(evidence.afterAdd.reserve1) > BigInt(evidence.afterSwap.reserve1),
  );
  check("popup-approved add liquidity increases both reserves and LP");
  stage = "remove liquidity";
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "25%", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove liquidity", exact: true })
    .click();
  await page
    .getByText("Removed liquidity", { exact: true })
    .waitFor({ timeout: 120000 });
  evidence.afterRemove = await snapshot();
  assert.ok(BigInt(evidence.afterRemove.lp) < BigInt(evidence.afterAdd.lp));
  assert.ok(
    BigInt(evidence.afterRemove.reserve0) < BigInt(evidence.afterAdd.reserve0),
  );
  assert.ok(
    BigInt(evidence.afterRemove.reserve1) < BigInt(evidence.afterAdd.reserve1),
  );
  check("popup-approved remove liquidity reduces both reserves and LP");
  await page.screenshot({ path: `${work}/evidence/liquidity.png` });
  stage = "connection rejection and account change";
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  rejectNext = true;
  await page
    .getByRole("button", { name: "Connect Groundhog Wallet", exact: true })
    .click();
  await page.getByText("User rejected the request", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Wallet account", { exact: true }).count(),
    0,
  );
  check("real extension connection rejection leaves app read-only");
  await wallet.getByRole("button", { name: "Settings", exact: true }).click();
  await wallet
    .getByRole("button", { name: "Add derived account", exact: true })
    .click();
  await until(
    async () => (await wallet.locator("#account option").count()) === 2,
    "second derived account",
  );
  await connect(page);
  const accountSelect = page.getByLabel("Wallet account", { exact: true });
  const accounts = await accountSelect
    .locator("option")
    .evaluateAll((nodes) => nodes.map((n) => n.value));
  assert.equal(accounts.length, 2);
  const other = accounts.find((address) => address !== evidence.creator);
  await accountSelect.selectOption(other);
  await page.getByText("0.00%", { exact: true }).waitFor();
  await accountSelect.selectOption(evidence.creator);
  await page.getByText("Your LP share", { exact: true }).waitFor();
  assert.deepEqual(await snapshot(), evidence.afterRemove);
  check(
    "second unfunded derived account and original account switch without chain writes",
  );
  for (const origin of [lo, so]) {
    const response = await fetch(`${origin}/groundhog-rpc`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_sendRawTransaction",
        params: ["0x"],
      }),
    });
    assert.equal(response.status, 403);
  }
  check("both public app RPC proxies reject transaction writes");
  stage = "wallet manual ERC20 add and transfer";
  try {
    await wallet.getByRole("button", { name: "Assets", exact: true }).click();
    await wallet.getByText("Add a token", { exact: true }).click();
    await wallet
      .getByLabel("Token contract address", { exact: true })
      .fill(evidence.token);
    await wallet
      .getByRole("button", { name: "Add token", exact: true })
      .click();
    await wallet
      .locator(".tokens")
      .getByText(evidence.tokens[0].symbol, { exact: true })
      .waitFor();
    // Infrastructure setup funds token initialization, not unbounded future
    // holder rows. Fund this user-created token's reserve through the real UI
    // before the first transfer to a new holder, never after an ambiguous send.
    await wallet.getByRole("button", { name: "Send", exact: true }).click();
    await wallet
      .locator('select[name="token"]')
      .selectOption(s.VITE_NATIVE_HOG_ADDRESS);
    await wallet
      .getByLabel("Recipient address", { exact: true })
      .fill(evidence.token);
    await wallet.getByLabel("Amount", { exact: true }).fill("0.01");
    await wallet
      .getByRole("button", { name: "Review transfer", exact: true })
      .click();
    await wallet
      .locator(".review")
      .getByText(evidence.token, { exact: true })
      .waitFor();
    await wallet
      .getByRole("button", { name: "Sign and send", exact: true })
      .click();
    await wallet.getByText(/^Confirmed:/).waitFor({ timeout: 35000 });
    evidence.tokenReserveFunding = {
      token: evidence.token,
      hog: "0.01",
      confirmation: await wallet.getByText(/^Confirmed:/).innerText(),
    };
    check(
      "wallet explicitly funds user-created token storage reserve before a new holder transfer",
    );
    const beforeTransfer = await snapshot(other);
    assert.equal(beforeTransfer.recipientBalances[0], "0");
    await wallet.getByRole("button", { name: "Send", exact: true }).click();
    await wallet.locator('select[name="token"]').selectOption(evidence.token);
    await wallet.getByLabel("Recipient address", { exact: true }).fill(other);
    await wallet.getByLabel("Amount", { exact: true }).fill("1");
    await wallet
      .getByRole("button", { name: "Review transfer", exact: true })
      .click();
    await wallet.locator(".review").getByText(other, { exact: true }).waitFor();
    await wallet
      .getByRole("button", { name: "Sign and send", exact: true })
      .click();
    await until(
      async () => {
        const alerts = await wallet.getByRole("alert").allTextContents();
        if (alerts.length)
          throw new Error(`Wallet transfer: ${alerts.join("; ")}`);
        const notice = (
          await wallet.getByRole("status").allTextContents()
        ).join("; ");
        if (
          /Execution failed|confirmation unavailable|Broadcast outcome unknown/.test(
            notice,
          )
        ) {
          evidence.walletTransferFailure = notice;
          throw new Error(notice);
        }
        return wallet.getByText(/^Confirmed:/).isVisible();
      },
      "wallet transfer confirmation",
      35000,
    );
    const afterTransfer = await snapshot(other);
    assert.equal(
      BigInt(beforeTransfer.balances[0]) - BigInt(afterTransfer.balances[0]),
      1000000n,
    );
    assert.equal(afterTransfer.recipientBalances[0], "1000000");
    assert.equal(afterTransfer.reserve0, beforeTransfer.reserve0);
    assert.equal(afterTransfer.reserve1, beforeTransfer.reserve1);
    assert.equal(afterTransfer.lp, beforeTransfer.lp);
    evidence.walletTransfer = {
      token: evidence.token,
      recipient: other,
      rawAmount: "1000000",
      before: beforeTransfer,
      after: afterTransfer,
    };
    await wallet.reload();
    await until(
      async () =>
        (await wallet
          .getByRole("region", { name: "Outgoing transfers" })
          .getByText("localnet / confirmed", { exact: true })
          .count()) === 2,
      "both persisted wallet transfer confirmations",
    );
    check(
      "wallet manual ERC20 addition, reviewed transfer and persistent confirmation match independent balances",
    );
  } catch (error) {
    evidence.walletTransferUI = await wallet.evaluate(() => ({
      notice: document.querySelector(".notice")?.textContent,
      alert: document.querySelector('[role="alert"]')?.textContent,
      outgoing: document.querySelector(
        'section[aria-label="Outgoing transfers"]',
      )?.textContent,
      hash: document.querySelector(
        'section[aria-label="Outgoing transfers"] article > p.mono',
      )?.textContent,
      actions: [...document.querySelectorAll("button")].map((button) => ({
        text: button.textContent,
        disabled: button.disabled,
      })),
    }));
    evidence.walletTransferObserved = await snapshot(other);
    if (/^0x[0-9a-f]{64}$/.test(evidence.walletTransferUI.hash ?? "")) {
      evidence.walletTransferStatus = await fetch(env.GROUNDHOG_RPC_URL, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "groundhog_getTransactionStatus",
          params: [evidence.walletTransferUI.hash],
        }),
      }).then((response) => response.json());
    }
    evidence.blockers.push({ stage, error: redact(error.message) });
    console.log(`BLOCKED ${stage}: ${redact(error.message)}`);
  }
  stage = "production build and server smoke";
  await productionSmoke(
    launchpad,
    "LAUNCHPAD",
    { ...l, VITE_SWAP_APP_URL: so },
    context,
  );
  await productionSmoke(swap, "SWAP", s, context);
  stage = "vault restore and key import unit coverage";
  await run(
    `${extension}/node_modules/.bin/vitest`,
    ["run", "src/vault.test.ts", "src/worker.test.ts"],
    extension,
  );
  check(
    "vault derivation/restore, encryption and private-key import worker unit coverage",
  );
  if (process.argv.includes("--devnet")) {
    stage = "devnet read-only preflight and throwaway airdrop";
    const started = Date.now();
    try {
      const response = await fetch(devnetRpc, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "groundhog_networkInfo",
          params: [],
        }),
      });
      assert.equal(
        response.status,
        200,
        "Devnet read-only networkInfo HTTP status",
      );
      const body = await response.json();
      if (body.error)
        throw new Error(
          `Devnet networkInfo RPC ${body.error.code}: ${body.error.message}`,
        );
      assert.match(body.result?.networkHash ?? "", /^0x[0-9a-f]{64}$/);
      evidence.devnet = {
        rpc: devnetRpc,
        networkHash: body.result.networkHash,
        readOnlyPreflight: "passed",
      };
      devnetAllowed = true;
      await wallet
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await wallet
        .getByRole("button", { name: "Add derived account", exact: true })
        .click();
      await until(
        async () => (await wallet.locator("#account option").count()) === 3,
        "devnet-only account",
      );
      const localAccounts = await wallet
        .locator("#account option")
        .evaluateAll((nodes) => nodes.map((n) => n.value));
      evidence.devnet.account = localAccounts.find(
        (address) => !accounts.includes(address),
      );
      assert.ok(evidence.devnet.account);
      await wallet
        .getByLabel("Account", { exact: true })
        .selectOption(evidence.devnet.account);
      await wallet
        .getByLabel("Network", { exact: true })
        .selectOption("devnet");
      await until(
        async () =>
          (await wallet
            .getByText(evidence.devnet.networkHash.slice(2), { exact: true })
            .count()) > 0,
        "extension pinned devnet identity",
        20000,
      );
      await wallet.getByRole("button", { name: "Assets", exact: true }).click();
      await wallet
        .getByText("Balances on devnet. No real-world value.", { exact: true })
        .waitFor({ timeout: 20000 });
      await wallet
        .getByRole("button", { name: "Request test HOG", exact: true })
        .click();
      await until(
        async () => {
          const alert = wallet.getByRole("alert");
          if (await alert.count()) throw new Error(await alert.innerText());
          return wallet.getByText(/^Airdrop confirmed:/).isVisible();
        },
        "one devnet test HOG airdrop",
        65000,
      );
      evidence.devnet.confirmation = await wallet
        .getByText(/^Airdrop confirmed:/)
        .innerText();
      const nativeBalance = wallet
        .locator(".tokens li")
        .filter({ has: wallet.getByText("HOG", { exact: true }) })
        .locator(".balance");
      await until(
        async () => Number(await nativeBalance.innerText()) > 0,
        "devnet airdrop balance",
        10000,
      );
      evidence.devnet.balanceHog = await nativeBalance.innerText();
      evidence.devnet.status = "passed";
      check(
        "devnet read-only preflight, extension toggle and one throwaway-account test HOG airdrop",
      );
    } catch (error) {
      evidence.devnet = {
        ...evidence.devnet,
        rpc: devnetRpc,
        status: "blocked",
        error: redact(error.message),
        cause: error.cause?.code,
        elapsedMs: Date.now() - started,
      };
      console.log(`BLOCKED devnet: ${evidence.devnet.error}`);
    } finally {
      devnetAllowed = false;
    }
  } else {
    evidence.devnet = { status: "not-requested" };
  }
  if (approvalError) throw approvalError;
  evidence.status = evidence.blockers.length ? "failed" : "passed";
  if (evidence.blockers.length) process.exitCode = 1;
  console.log(
    `${evidence.status.toUpperCase()} local/production acceptance (${evidence.checks.length} checks; ${evidence.blockers.length} blockers; devnet ${evidence.devnet.status})`,
  );
} catch (error) {
  evidence.status = "failed";
  evidence.stage = stage;
  evidence.error = redact(error.stack || String(error));
  console.error(`FAIL ${stage}: ${evidence.error}`);
  // Never dump or screenshot extension pages: a failed onboarding may expose backup words.
  for (const page of context?.pages() || [])
    if (/^http:\/\//.test(page.url())) {
      const text = redact(
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable"),
      );
      await writeFile(`${work}/evidence/app-failure.txt`, text, {
        mode: 0o600,
      });
      await page
        .screenshot({ path: `${work}/evidence/app-failure.png` })
        .catch(() => {});
      const workflows = await page
        .evaluate(() =>
          Object.entries(localStorage).filter(([key]) =>
            /launch|swap|groundhog/i.test(key),
          ),
        )
        .catch(() => []);
      await writeFile(
        `${work}/evidence/workflows.json`,
        JSON.stringify(workflows, null, 2),
        { mode: 0o600 },
      );
    }
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await context?.close().catch(() => {});
  proxy?.closeAllConnections();
  if (proxy) await new Promise((r) => proxy.close(r));
  let cleanupFailure;
  try {
    evidence.processGroups = await processGroups.stopAll();
  } catch (error) {
    cleanupFailure = error;
  }
  let i = 0;
  for (const output of logs.values())
    await writeFile(`${work}/evidence/process-${i++}.log`, redact(output()), {
      mode: 0o600,
    });
  if (!cleanupFailure)
    for (const name of (await readdir(work)).filter(
      (name) => name !== "evidence",
    ))
      await rm(`${work}/${name}`, { recursive: true, force: true });
  try {
    if (cleanupFailure) throw cleanupFailure;
    assert.deepEqual(
      await Promise.all(protectedPaths.map(fingerprint)),
      before,
      "User .env.local changed during acceptance",
    );
    evidence.cleanup =
      "All owned process groups verified gone; temporary state removed; user app env files unchanged";
  } catch (error) {
    evidence.status = "failed";
    evidence.cleanup = error.message;
    process.exitCode = 1;
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    `${work}/evidence/result.json`,
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `${cleanupFailure ? "Cleanup failed; temporary state retained" : "Cleanup complete"}. Sanitized evidence: ${work}/evidence`,
  );
}
