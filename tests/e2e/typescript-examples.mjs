// Acceptance harness, not a teaching example: run the actual scripts on a fresh node.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

assert.ok(process.env.THRUPUT_CLI, "Set THRUPUT_CLI to CLI 0.39.0");
assert.ok(
  process.env.THRUPUT_DEVNODE_BINARY,
  "Set THRUPUT_DEVNODE_BINARY to the matching runtime",
);
const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-client-examples-"));
const groups = new OwnedProcessGroups();
const controller = new AbortController();
const interrupt = () =>
  controller.abort(new Error("Example acceptance interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 180_000);
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: join(work, "config"),
  XDG_DATA_HOME: join(work, "data"),
  XDG_CACHE_HOME: join(work, "cache"),
};

function spawn(command, args, extra = {}) {
  controller.signal.throwIfAborted();
  const child = groups.spawn(command, args, {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    signal: controller.signal,
  });
  let stdout = "";
  let stderr = "";
  let error;
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.on("error", (cause) => {
    error = cause;
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    error: () => error,
  };
}

try {
  const node = spawn(process.env.THRUPUT_CLI, [
    "node",
    "--port",
    "0",
    "--json",
    "--hog-devnode-binary",
    process.env.THRUPUT_DEVNODE_BINARY,
  ]);
  let startup;
  const deadline = Date.now() + 60_000;
  while (!startup) {
    controller.signal.throwIfAborted();
    if (node.error()) throw node.error();
    assert.equal(node.child.exitCode, null, node.stderr());
    assert.ok(Date.now() < deadline, "Timed out waiting for node startup");
    try {
      startup = JSON.parse(node.stdout());
    } catch {
      await delay(100);
    }
  }
  assert.equal(startup.ok, true, node.stderr());
  assert.equal(typeof startup.data.rpcUrl, "string", "Missing isolated RPC URL");

  async function run(name, settings = {}, expectedCode = 0) {
    const command = spawn(
      join(root, "node_modules/.bin/tsx"),
      [`examples/typescript/${name}.ts`],
      { THRUPUT_RPC_URL: startup.data.rpcUrl, ...settings },
    );
    const code = await new Promise((resolve, reject) => {
      command.child.once("error", reject);
      command.child.once("close", resolve);
    });
    assert.equal(code, expectedCode, `${name}: ${command.stderr()}`);
    console.log(`PASS ${name}${expectedCode ? " (expected failure)" : ""}`);
    return expectedCode ? command.stderr() : JSON.parse(command.stdout());
  }

  const tip = await run("chain-tip");
  assert.match(tip.height, /^\d+$/);
  const transfer = await run("transfer-native-token");
  assert.equal(transfer.transferredRaw, "1000");
  const balance = await run("view-native-token-balance", {
    THRUPUT_ADDRESS: transfer.recipient,
  });
  assert.equal(balance.rawBalance, transfer.recipientBalance);
  const pq = await run("pq-account");
  assert.equal(pq.transferredRawEach, "1000");
  assert.notEqual(pq.ed25519.sender, pq.mlDsa65.sender);
  const deployment = await run("deploy-counter");
  assert.equal(deployment.value, "47");
  const settings = { THRUPUT_COUNTER_ADDRESS: deployment.contractAddress };
  const events = await run("read-events", settings);
  assert.deepEqual(events.tags, ["7"]);
  const batch = await run("batch-counter", settings);
  assert.equal(batch.before, "47");
  assert.equal(batch.after, "50");
  assert.equal(batch.afterRollback, "50");
  assert.match(
    await run("view-native-token-balance", { THRUPUT_ADDRESS: "" }, 1),
    /Set THRUPUT_ADDRESS/,
  );
  assert.match(
    await run("read-events", { THRUPUT_COUNTER_ADDRESS: "" }, 1),
    /Set THRUPUT_COUNTER_ADDRESS/,
  );
  assert.match(
    await run("chain-tip", { THRUPUT_RPC_URL: "https://example.com" }, 1),
    /loopback HTTP/,
  );
  console.log(
    "PASS published-SDK examples: reads, transfer, ML-DSA-65 account, deployment, events, batch, and rollback",
  );
} finally {
  clearTimeout(watchdog);
  await groups.stopAll();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  console.log(`Isolated node state: ${work}`);
}
