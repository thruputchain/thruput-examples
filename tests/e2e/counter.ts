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
import { createCounterConnection } from "../../apps/counter/src/thruput/client.ts";
import { TransactionEngine } from "../../apps/counter/src/transactions/engine.ts";
import { addressFromBase58 } from "@thruputchain/client";
import { Counter } from "../../apps/counter/src/contracts/generated/counter.ts";
import { createPublicClient } from "../../apps/counter/src/thruput/public-client.ts";

assert.ok(
  process.env.THRUPUT_DEVNODE_BINARY,
  "Set THRUPUT_DEVNODE_BINARY to a compatible hog-devnode executable",
);

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-counter-"));
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
    { data: { rpcUrl: string; runtimeManifest: { path: string } } } | undefined;
  await until(() => {
    assert.equal(
      child.exitCode,
      null,
      `Node stopped: ${stderr.replace(/(?:0x)?[0-9a-f]{64}/gi, "[hex32]")}`,
    );
    try {
      startup = JSON.parse(stdout);
      return !!startup?.data.rpcUrl;
    } catch {
      return false;
    }
  }, "node startup");
  const environment = {
    THRUPUT_RPC_URL: startup!.data.rpcUrl,
    THRUPUT_RUNTIME_MANIFEST: startup!.data.runtimeManifest.path,
    COUNTER_APP_ENV: join(work, ".env.local"),
  };
  await setup(environment);
  const previousSetup = loadServerConfig(
    parseEnv(await readFile(environment.COUNTER_APP_ENV, "utf8")),
  );
  await setup(environment);
  const before = await readFile(environment.COUNTER_APP_ENV, "utf8");
  const config = loadServerConfig(parseEnv(before));
  assert.notEqual(
    config.app.counterAddress,
    previousSetup.app.counterAddress,
    "Setup must create a fresh counter",
  );
  assert.notEqual(
    config.app.signerAddress,
    previousSetup.app.signerAddress,
    "Setup must create a fresh signer",
  );
  server = createCounterServer(config);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const publicResponse = await fetch(`${origin}/api/config`);
  const publicConfig = await publicResponse.text();
  assert.ok(
    !publicConfig.includes(config.signingPrivateKey!),
    "Public config must not include the signing key",
  );
  const connection = await createCounterConnection(
    config.app,
    `${origin}/thruput-rpc`,
  );
  engine = new TransactionEngine(connection);
  const readClient = await createPublicClient(
    config.app,
    `${origin}/thruput-rpc`,
  );
  const readValue = async () =>
    (
      await Counter.v0_1.get.view({
        client: readClient,
        address: addressFromBase58(config.app.counterAddress),
      })
    ).value;
  timer = setInterval(() => engine!.tick(), 25);
  await until(() => engine!.snapshot().ready, "engine readiness");
  assert.equal(await readValue(), 1_000_000n);
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
    async () => (await readValue()) === 1_000_040n,
    "final counter value",
  );
  console.log("Live burst: 120/120 confirmed; final value 1,000,040.");
  clearInterval(timer);
  engine.stop();

  const rpcUrl = config.rpcUrl;
  config.rpcUrl = "http://127.0.0.1:1";
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
  await page
    .getByText("Node connections retry automatically.", { exact: false })
    .waitFor();
  assert.equal(await inc.count(), 0);
  config.rpcUrl = rpcUrl;
  await inc.waitFor();
  await until(() => inc.isEnabled(), "browser connection");
  assert.equal(
    await page.getByRole("button", { name: /connect wallet/i }).count(),
    0,
  );
  assert.equal(await page.getByText("Ready", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("alert").count(), 0);
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
  await until(
    async () =>
      (await page.getByTestId("counter-value").textContent()) === "1,000,040",
    "counter before top-up",
  );
  const topup = page.getByRole("button", { name: /^Top up Signer/ });
  const header = page.locator("header");
  const headerHeight = (await header.boundingBox())!.height;
  const balanceBefore = await topup.getAttribute("title");
  let releaseTopup!: () => void;
  const topupGate = new Promise<void>((resolve) => {
    releaseTopup = resolve;
  });
  await page.route("**/api/topup", async (route) => {
    await topupGate;
    await route.continue();
  });
  await topup.click();
  await page.locator('[data-sonner-toast][data-type="loading"]').waitFor();
  assert.equal(
    (await header.boundingBox())!.height,
    headerHeight,
    "Loading toast must not resize the header",
  );
  releaseTopup();
  await until(
    () => page.getByText(/^Signer received .* native tokens\.$/).isVisible(),
    "signer airdrop confirmation",
  );
  await page.unroute("**/api/topup");
  await until(async () => {
    const title = await topup.getAttribute("title");
    return !!title?.startsWith("Signer balance:") && title !== balanceBefore;
  }, "updated signer balance in the button");
  assert.equal(
    (await header.boundingBox())!.height,
    headerHeight,
    "Success toast must not resize the header",
  );
  assert.equal(
    await page.getByTestId("counter-value").textContent(),
    "1,000,040",
  );
  assert.equal(
    await page.locator('[data-metric="Submitted"]').textContent(),
    "2",
    "Airdrops must not count as counter transactions",
  );
  await pad.click();
  for (let index = 0; index < 30; index++)
    await page.keyboard.press(index % 2 === 0 ? "a" : "b");
  await page.keyboard.down("c");
  for (let index = 0; index < 9; index++) await page.keyboard.down("c");
  await page.keyboard.up("c");
  await page.keyboard.press("Escape");
  await page.keyboard.press("z");
  await pad.click();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  assert.equal(
    await pad.evaluate((element) => element === document.activeElement),
    false,
  );
  await page.keyboard.press("x");
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
  await page.getByRole("alert").waitFor();
  config.rpcUrl = rpcUrl;
  await until(() => inc.isEnabled(), "reconnect after RPC outage");
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await page.getByText("Ready", { exact: true }).count(), 0);
  assert.equal(
    await page.locator('[data-metric="Submitted"]').textContent(),
    "42",
  );
  await page.screenshot({
    path: join(work, "counter-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  // Measure the mobile layout after fonts and the resized frame have settled.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  const mobileHeaderHeight = (await header.boundingBox())!.height;
  await page.route("**/api/topup", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Faucet cooldown. Try again later." }),
    }),
  );
  await topup.click();
  await page
    .locator('[data-sonner-toast][data-type="error"]')
    .getByText("Faucet cooldown. Try again later.")
    .waitFor();
  assert.equal(
    (await header.boundingBox())!.height,
    mobileHeaderHeight,
    "Error toast must not resize the mobile header",
  );
  assert.ok(!(await header.textContent())?.includes("Faucet cooldown"));
  await page.unroute("**/api/topup");
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
    `Browser: 42/42 counter transactions confirmed; signer top-up, key repeat, Escape, startup retry, and outage recovery verified. No page errors or mobile overflow. Screenshots: ${work}`,
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
