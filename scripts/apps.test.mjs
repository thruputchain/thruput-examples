import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const apps = ["counter", "token-launchpad", "swap", "voting", "airdrop"];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "app-runner-test-"));
  await symlink(process.execPath, join(directory, "node"));
  await symlink("/bin/sh", join(directory, "sh"));
  const env = {
    PATH: directory,
    LOG: join(directory, "calls.jsonl"),
    LAUNCHPAD_APP_ENV: join(directory, "launchpad.env"),
    SWAP_APP_ENV: join(directory, "swap.env"),
    AIRDROP_ENV_PATH: join(directory, "airdrop.env"),
  };
  // Exercise the real runner with a stand-in npm; no node or app deployments.
  await writeFile(
    join(directory, "npm"),
    `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const command = process.argv[3];
const app = process.argv[5].split("/").at(-1);
const log = event => appendFileSync(process.env.LOG, JSON.stringify({ app, event, pid: process.pid }) + "\\n");
if (command === "setup:local") {
  log("start");
  if (app === process.env.FAIL_APP) process.exit(1);
  if (app === "token-launchpad") writeFileSync(process.env.LAUNCHPAD_APP_ENV, "VITE_THRUPUT_NETWORK_ID=network\\nVITE_STANDARD_TOKEN_FACTORY_ADDRESS=factory\\nVITE_STANDARD_TOKEN_HASH=code\\n");
  if (app === "swap") writeFileSync(process.env.SWAP_APP_ENV, "VITE_THRUPUT_NETWORK_ID=network\\n");
} else {
  process.on("SIGTERM", () => { log("stop"); process.exit(0); });
  process.on("SIGINT", () => { log("stop"); process.exit(0); });
  log("start");
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o700 },
  );
  let child;
  let done;
  t.after(async () => {
    // Also clean detached fixture apps if the parent fails during shutdown.
    for (const { pid, event } of await calls()) {
      if (event !== "start") continue;
      try {
        process.kill(-pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await done;
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function calls() {
    try {
      return (await readFile(env.LOG, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  function start(command, extra = {}, npmCli) {
    child = spawn(
      process.execPath,
      npmCli ? [npmCli, "run", command] : ["scripts/apps.mjs", command],
      {
        env: { ...env, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
        detached: !!npmCli,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    return { child, done };
  }
  return { env, calls, start };
}

test("setup uses app defaults, runs in order, and connects Launchpad to Swap", async (t) => {
  const f = await fixture(t);
  const result = await f.start("setup:local").done;
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    (await f.calls()).map((call) => call.app),
    apps,
  );
  assert.match(
    await readFile(f.env.LAUNCHPAD_APP_ENV, "utf8"),
    /VITE_SWAP_APP_URL=http:\/\/127.0.0.1:5174/,
  );
  assert.match(
    await readFile(f.env.SWAP_APP_ENV, "utf8"),
    /VITE_STANDARD_TOKEN_FACTORY_ADDRESS=factory/,
  );
});

test("an existing Airdrop environment stops setup before any app runs", async (t) => {
  const f = await fixture(t);
  await writeFile(f.env.AIRDROP_ENV_PATH, "existing distribution");
  const result = await f.start("setup:local").done;
  assert.equal(result.code, 1);
  assert.deepEqual(await f.calls(), []);
  assert.equal(
    await readFile(f.env.AIRDROP_ENV_PATH, "utf8"),
    "existing distribution",
  );
});

test("a failed app stops subsequent setup steps", async (t) => {
  const f = await fixture(t);
  const result = await f.start("setup:local", { FAIL_APP: "token-launchpad" })
    .done;
  assert.equal(result.code, 1);
  assert.deepEqual(
    (await f.calls()).map((call) => call.app),
    apps.slice(0, 2),
  );
});

test(
  "stopping dev stops all five app processes",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const { child, done } = f.start("dev");
    const deadline = Date.now() + 5000;
    while ((await f.calls()).length < apps.length) {
      assert.ok(Date.now() < deadline, "All apps must start");
      await delay(25);
    }
    child.kill("SIGTERM");
    const result = await done;
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      (await f.calls())
        .filter((call) => call.event === "stop")
        .map((call) => call.app)
        .sort(),
      [...apps].sort(),
    );
  },
);

test(
  "Ctrl+C through real npm shuts down every app despite forwarded signals",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const npmCli =
      process.env.npm_execpath ||
      join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    const { child, done } = f.start("dev", {}, npmCli);
    const deadline = Date.now() + 5000;
    while ((await f.calls()).length < apps.length) {
      if (child.exitCode !== null) assert.fail((await done).output);
      assert.ok(Date.now() < deadline, "All apps must start");
      await delay(25);
    }
    process.kill(-child.pid, "SIGINT");
    const result = await done;
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      (await f.calls())
        .filter((call) => call.event === "stop")
        .map((call) => call.app)
        .sort(),
      [...apps].sort(),
    );
  },
);
