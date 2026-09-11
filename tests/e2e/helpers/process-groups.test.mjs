import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OwnedProcessGroups } from "./process-groups.mjs";

const linuxOnly = { skip: process.platform !== "linux" };

test(
  "cleans surviving TERM-resistant descendants after the launcher closes",
  { ...linuxOnly, timeout: 15000 },
  async (t) => {
    const groups = new OwnedProcessGroups({
      graceMs: 150,
      killTimeoutMs: 5000,
    });
    t.after(() => groups.stopAll());
    const descendant = `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    process.send({ pid: process.pid });
  `;
    const launcher = groups.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.once('message', message => {
      process.stdout.write(JSON.stringify(message), () => {
        child.disconnect();
        child.unref();
        process.exit(0);
      });
    });
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    launcher.stdout.on("data", (bytes) => {
      output += bytes;
    });
    launcher.stderr.resume();
    await once(launcher, "close");
    assert.equal(launcher.exitCode, 0);
    const pid = JSON.parse(output).pid;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    assert.equal(
      Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]),
      launcher.pid,
    );
    assert.doesNotThrow(() => process.kill(-launcher.pid, 0));
    assert.doesNotThrow(() => process.kill(pid, 0));

    const started = Date.now();
    await Promise.all([
      groups.stopAll(),
      groups.stop(launcher),
      groups.stopAll(),
    ]);
    assert.ok(
      Date.now() - started >= 150,
      "The descendant must survive the TERM grace period",
    );
    assert.throws(() => process.kill(-launcher.pid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(await groups.stopAll(), {
      spawned: 1,
      verifiedExited: 1,
      remaining: 0,
    });
  },
);

test(
  "does not signal a detached group owned by another registry",
  { ...linuxOnly, timeout: 10000 },
  async (t) => {
    const groups = new OwnedProcessGroups();
    const unrelated = new OwnedProcessGroups();
    t.after(() => unrelated.stopAll());
    const child = unrelated.spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    await once(child, "spawn");
    await groups.stop(child);
    await groups.stopAll();
    await delay(50);
    assert.equal(child.exitCode, null);
    assert.doesNotThrow(() => process.kill(-child.pid, 0));
  },
);

test("does not register a failed spawn", linuxOnly, async () => {
  const groups = new OwnedProcessGroups();
  const child = groups.spawn("/nonexistent-wallet-acceptance-executable", [], {
    stdio: "ignore",
  });
  const [error] = await once(child, "error");
  assert.equal(error.code, "ENOENT");
  assert.deepEqual(await groups.stopAll(), {
    spawned: 0,
    verifiedExited: 0,
    remaining: 0,
  });
});
