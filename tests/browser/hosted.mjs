import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { OwnedProcessGroups } from "../e2e/helpers/process-groups.mjs";

// Run after setup:local. This checks real production servers and the same Caddy
// routes used on Railway. It does not deploy contracts or submit transactions.
const apps = [
  {
    name: "counter",
    path: "counter",
    port: 25175,
    route: "",
    heading: "Every key counts",
  },
  {
    name: "token-launchpad",
    path: "launchpad",
    port: 25173,
    route: "tokens",
    heading: "Tokens",
  },
  { name: "swap", path: "swap", port: 25174, route: "pools", heading: "Pools" },
  {
    name: "voting",
    path: "voting",
    port: 25176,
    route: "new",
    heading: "Start with a question",
  },
];
const groups = new OwnedProcessGroups();
const site = await mkdtemp(join(tmpdir(), "examples-hosted-"));
let browser;
async function ready(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited before ${url}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${url}`);
}
try {
  await cp("apps/gateway/public", site, { recursive: true });
  await cp("apps/counter/public/brand", join(site, "brand"), {
    recursive: true,
  });
  await cp("apps/counter/public/favicon.svg", join(site, "favicon.svg"));
  for (const app of apps) {
    const env = {
      ...process.env,
      ...parseEnv(await readFile(`apps/${app.name}/.env.local`, "utf8")),
      PORT: String(app.port),
      APP_BASE_PATH: `/${app.path}/`,
    };
    env.TOKEN_REGISTRY_DB_PATH = join(site, "tokens.sqlite");
    env.POOL_REGISTRY_DB_PATH = join(site, "pools.sqlite");
    if (app.name === "swap")
      env.TOKEN_DISCOVERY_UPSTREAM_ORIGIN = "http://127.0.0.1:25173";
    const build = spawnSync(
      "npm",
      ["run", "build", "--workspace", `apps/${app.name}`],
      { env, stdio: "inherit" },
    );
    assert.equal(build.status, 0, `${app.name} build`);
    const child = groups.spawn(
      process.execPath,
      ["--import", "tsx", "server/main.ts"],
      { cwd: `apps/${app.name}`, env, stdio: "inherit" },
    );
    await ready(`http://127.0.0.1:${app.port}/healthz`, child);
  }
  const gateway = groups.spawn(
    process.env.CADDY_BINARY || "caddy",
    ["run", "--config", "apps/gateway/Caddyfile", "--adapter", "caddyfile"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PORT: "25180",
        SITE_ROOT: site,
        XDG_CONFIG_HOME: join(site, "config"),
        XDG_DATA_HOME: join(site, "data"),
        COUNTER_UPSTREAM: "127.0.0.1:25175",
        LAUNCHPAD_UPSTREAM: "127.0.0.1:25173",
        SWAP_UPSTREAM: "127.0.0.1:25174",
        VOTING_UPSTREAM: "127.0.0.1:25176",
      },
    },
  );
  const origin = "http://127.0.0.1:25180";
  await ready(`${origin}/healthz`, gateway);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  for (const width of [320, 1280]) {
    for (const colorScheme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page
        .getByRole("heading", { name: "Try it. Build on it." })
        .waitFor();
      assert.equal(await page.locator("nav a").count(), 4);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: join(site, `index-${width}-${colorScheme}.png`),
      });
      for (const app of apps) {
        const prefix = `/${app.path}/`;
        assert.equal(
          (await fetch(`${origin}/${app.path}`, { redirect: "manual" })).status,
          308,
        );
        assert.equal((await fetch(`${origin}${prefix}api/config`)).status, 200);
        await page.goto(`${origin}${prefix}${app.route}`);
        await page
          .getByRole("heading", { name: app.heading, exact: true })
          .waitFor();
        await page.reload();
        await page
          .getByRole("heading", { name: app.heading, exact: true })
          .waitFor();
        await page.waitForFunction(() =>
          [...document.images].every(
            (img) => img.complete && img.naturalWidth > 0,
          ),
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          app.name,
        );
        assert.ok(new URL(page.url()).pathname.startsWith(prefix));
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log(
    "Hosted routes, reloads, assets, config, and responsive layouts passed.",
  );
} finally {
  await browser?.close();
  await groups.stopAll();
  await rm(site, { recursive: true, force: true });
}
