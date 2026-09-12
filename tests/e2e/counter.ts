// Explicit live check: npm run test:counter (build apps/counter first).
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";
import { setup } from "../../apps/counter/scripts/setup-local.ts";
import { loadServerConfig } from "../../apps/counter/server/config.ts";
import { createCounterServer } from "../../apps/counter/server/main.ts";
import { createCounterConnection } from "../../apps/counter/src/groundhog/client.ts";
import { TransactionEngine } from "../../apps/counter/src/transactions/engine.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "groundhog-counter-"));
const groups = new OwnedProcessGroups();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createCounterServer> | undefined;
let vite: ViteDevServer | undefined;
let engine: TransactionEngine | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  void groups.stopAll();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 180_000);

async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
) {
  const deadline = Date.now() + 60_000;
  while (!(await check())) {
    assert.ok(
      !interrupted && Date.now() < deadline,
      `Timed out: ${description}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

try {
  const child = groups.spawn(
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
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", (error: Error) => {
    stderr += error.message;
  });
  let startup:
    | { data: { rpc_url: string; runtime_manifest: { path: string } } }
    | undefined;
  await until(() => {
    assert.equal(
      child.exitCode,
      null,
      `Node stopped: ${stderr.replace(/(?:0x)?[0-9a-f]{64}/gi, "[hex32]")}`,
    );
    try {
      startup = JSON.parse(stdout);
      return !!startup?.data.rpc_url;
    } catch {
      return false;
    }
  }, "node startup");
  const environment = {
    GROUNDHOG_RPC_URL: startup!.data.rpc_url,
    GROUNDHOG_RUNTIME_MANIFEST: startup!.data.runtime_manifest.path,
    COUNTER_APP_ENV: join(work, ".env.local"),
  };
  await setup(environment);
  const before = await readFile(environment.COUNTER_APP_ENV, "utf8");
  await setup(environment);
  assert.equal(
    await readFile(environment.COUNTER_APP_ENV, "utf8"),
    before,
    "Setup rerun must preserve the signer and deployment",
  );
  const config = loadServerConfig(parseEnv(before));
  const connection = await createCounterConnection(config.app, config.rpcUrl);
  engine = new TransactionEngine(connection);
  timer = setInterval(() => engine!.tick(), 25);
  await until(() => engine!.snapshot().ready, "engine readiness");
  assert.equal(engine.snapshot().value, 1_000_000n);
  for (let index = 0; index < 120; index++)
    assert.ok(engine.enqueue(index % 3 === 0 ? "decrement" : "increment"));
  await until(
    () => engine!.snapshot().confirmed + engine!.snapshot().failed === 120,
    "120 concurrent outcomes",
  );
  assert.equal(
    engine.snapshot().failed,
    0,
    JSON.stringify(engine.snapshot().recent),
  );
  await until(
    () => engine!.snapshot().value === 1_000_040n,
    "final counter value",
  );
  console.log("Live burst: 120/120 confirmed; final value 1,000,040.");
  clearInterval(timer);
  engine.stop();

  const rpcUrl = config.rpcUrl;
  config.rpcUrl = "http://127.0.0.1:1";
  server = createCounterServer(config);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const inc = page.getByRole("button", { name: "Increment", exact: true });
  await inc.waitFor();
  await page
    .getByText("Node connections retry automatically.", { exact: false })
    .waitFor();
  assert.equal(await inc.isEnabled(), false);
  config.rpcUrl = rpcUrl;
  await until(() => inc.isEnabled(), "browser connection");
  await inc.click();
  await until(
    async () =>
      (await page.locator('[data-metric="Confirmed"]').textContent()) === "1",
    "button receipt",
  );
  await page.getByRole("button", { name: "Decrement", exact: true }).focus();
  await page.keyboard.press("Enter");
  await until(
    async () =>
      (await page.locator('[data-metric="Confirmed"]').textContent()) === "2",
    "button keyboard activation",
  );
  const pad = page.getByRole("group", { name: "Keyboard transaction area" });
  await pad.click();
  for (let index = 0; index < 30; index++)
    await page.keyboard.press(index % 2 === 0 ? "a" : "b");
  await page.keyboard.down("c");
  for (let index = 0; index < 9; index++) await page.keyboard.down("c");
  await page.keyboard.up("c");
  await page.keyboard.press("Escape");
  await page.keyboard.press("z");
  await until(
    async () =>
      (await page.locator('[data-metric="Confirmed"]').textContent()) === "42",
    "keyboard burst receipts",
  );
  assert.equal(
    await page.locator('[data-metric="Submitted"]').textContent(),
    "42",
  );
  assert.equal(await pad.getAttribute("data-active"), "false");
  config.rpcUrl = "http://127.0.0.1:1";
  await until(async () => !(await inc.isEnabled()), "pause during RPC outage");
  config.rpcUrl = rpcUrl;
  await until(() => inc.isEnabled(), "reconnect after RPC outage");
  assert.equal(
    await page.locator('[data-metric="Submitted"]').textContent(),
    "42",
  );
  await page.screenshot({
    path: join(work, "counter-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile must not overflow",
  );
  await page.screenshot({
    path: join(work, "counter-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    `Browser: 42/42 confirmed; key repeat, Escape, startup retry, and outage recovery verified. No page errors or mobile overflow. Screenshots: ${work}`,
  );

  const appEnvironment = parseEnv(before);
  const previous = Object.fromEntries(
    Object.keys(appEnvironment).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, appEnvironment);
    vite = await createViteServer({
      root: join(root, "apps/counter"),
      server: { host: "127.0.0.1", port: 0 },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await vite.listen();
  const devAddress = vite.httpServer!.address();
  assert.ok(devAddress && typeof devAddress !== "string");
  await page.goto(`http://127.0.0.1:${devAddress.port}`);
  await until(
    () =>
      page.getByRole("button", { name: "Increment", exact: true }).isEnabled(),
    "Vite browser connection",
  );
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await until(
    async () =>
      (await page.locator('[data-metric="Confirmed"]').textContent()) === "1",
    "Vite worker transaction",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Vite development server: signed transaction confirmed through the worker and RPC proxy.",
  );
} finally {
  clearTimeout(watchdog);
  clearInterval(timer);
  engine?.stop();
  await browser?.close();
  await vite?.close();
  if (server)
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server!.closeAllConnections();
    });
  await groups.stopAll();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
