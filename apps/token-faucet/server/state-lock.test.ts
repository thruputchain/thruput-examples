import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireStateLock } from "./state-lock";

const directories: string[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "faucet-lock-"));
  directories.push(path);
  return path;
}

it.each(["faucet server", "faucet setup process"])(
  "refuses a second %s and permits restart after release",
  async (owner) => {
    const path = await directory();
    const release = acquireStateLock(path, owner);
    releases.push(release);
    expect(() => acquireStateLock(path, owner)).toThrow(`Another ${owner}`);
    release();
    releases.push(acquireStateLock(path, owner));
  },
);

it("ignores an obsolete directory lock", async () => {
  const path = await directory();
  await mkdir(join(path, "lock"));
  releases.push(acquireStateLock(path));
});

it("releases the lock after an abrupt process death", async () => {
  const path = await directory();
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('BEGIN EXCLUSIVE');
    process.send('locked');
    setInterval(() => {}, 1000);
  `,
      join(path, "server-lock.sqlite"),
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const exit = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exit.then(() => {
        throw new Error("Lock holder exited before acquiring the lock");
      }),
    ]);
    expect(() => acquireStateLock(path)).toThrow("Another faucet server");
    child.kill("SIGKILL");
    await exit;
    releases.push(acquireStateLock(path));
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exit;
  }
});
