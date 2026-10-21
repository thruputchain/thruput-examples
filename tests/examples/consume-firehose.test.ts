// Included by npm test; only loopback WebSockets and temporary files are used.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

type Cursor = { from: "tip" } | { from: "height"; height: number };
type Ack = { socket: WebSocket; id: number; height: number };
const children: ChildProcess[] = [];
const servers: WebSocketServer[] = [];
const directories: string[] = [];

function kill(child: ChildProcess) {
  // tsx launches another Node process: terminate the entire test-owned group.
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function until(
  check: () => unknown | Promise<unknown>,
  diagnostic = "condition",
) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${diagnostic}`);
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      kill(child);
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((done) => child.once("exit", () => done()));
      }
    }),
  );
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done) => server.close(() => done()));
    }),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "consume-firehose-"));
  directories.push(directory);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once("listening", done);
    server.once("error", reject);
  });
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("No server port");
  const url = `ws://127.0.0.1:${address.port}`;
  const cursors: Cursor[] = [];
  const acks: Ack[] = [];
  const violations: string[] = [];
  const subscriptions: {
    socket: WebSocket;
    id: number;
    outstanding?: number;
  }[] = [];
  function reply(ack: Ack) {
    ack.socket.send(
      JSON.stringify({ jsonrpc: "2.0", id: ack.id, result: null }),
    );
  }
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      if (request.method === "firehose_subscribe") {
        cursors.push(request.params[0]);
        const id = subscriptions.length + 1;
        subscriptions.push({ socket, id });
        socket.send(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: id }),
        );
      } else if (request.method === "firehose_ack") {
        const subscription = subscriptions.find(
          (entry) => entry.socket === socket,
        );
        if (
          !subscription ||
          request.params[0] !== subscription.id ||
          request.params[1] !== subscription.outstanding
        ) {
          violations.push("ACK did not match outstanding block");
          return;
        }
        delete subscription.outstanding;
        // Tests explicitly release, drop, or leave this reply pending.
        acks.push({ socket, id: request.id, height: request.params[1] });
      } else violations.push(`Unexpected method: ${request.method}`);
    });
  });
  function notify(result: object) {
    const subscription = subscriptions.at(-1)!;
    subscription.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "firehose_block",
        params: { subscription: subscription.id, result },
      }),
    );
  }
  const bytes = (height: number) => Buffer.from([0, height, 255, 128]);
  function block(height: number) {
    const subscription = subscriptions.at(-1)!;
    expect(subscription.outstanding).toBeUndefined();
    subscription.outstanding = height;
    notify({
      type: "block",
      subscriberId: subscription.id,
      block: {
        height,
        byteLength: bytes(height).length,
        record: `0x${bytes(height).toString("hex")}`,
        consensusHash: `0x${"ab".repeat(32)}`,
        ingestedAtUnixMicros: 123456,
      },
    });
  }
  function start() {
    const child = spawn(
      resolve("node_modules/.bin/tsx"),
      ["examples/typescript/consume-firehose.ts"],
      {
        env: { ...process.env, FIREHOSE_URL: url, OUTPUT_DIR: directory },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    children.push(child);
    let output = "";
    child.stdout!.on("data", (data) => {
      output += String(data);
    });
    child.stderr!.on("data", (data) => {
      output += String(data);
    });
    return { child, output: () => output };
  }
  async function checkpoint() {
    try {
      return JSON.parse(await readFile(join(directory, "cursor.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async function acknowledged(height: number) {
    block(height);
    const index = acks.length;
    await until(() => acks.length > index, `ACK for ${height}`);
    expect(acks[index]!.height).toBe(height);
    expect(await readFile(join(directory, `${height}.xdr`))).toEqual(
      bytes(height),
    );
    expect(await checkpoint()).toEqual({ url, nextHeight: height });
    reply(acks[index]!);
    await until(
      async () => (await checkpoint())?.nextHeight === height + 1,
      "advanced checkpoint",
    );
  }
  async function files(heights: number[]) {
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".xdr")).sort(),
    ).toEqual(heights.map((height) => `${height}.xdr`).sort());
    for (const height of heights)
      expect(await readFile(join(directory, `${height}.xdr`))).toEqual(
        bytes(height),
      );
    expect(violations).toEqual([]);
  }
  return {
    start,
    cursors,
    acks,
    block,
    notify,
    checkpoint,
    acknowledged,
    files,
    url,
  };
}

it("starts at tip and durably advances after each ACK reply", async () => {
  const f = await fixture();
  f.start();
  await until(() => f.cursors.length === 1, "subscription");
  expect(f.cursors).toEqual([{ from: "tip" }]);
  for (const height of [40, 41, 42]) await f.acknowledged(height);
  await f.files([40, 41, 42]);
}, 10000);

it("reconnects at the inclusive saved height when an ACK reply is lost", async () => {
  const f = await fixture();
  f.start();
  await until(() => f.cursors.length === 1);
  await f.acknowledged(40);
  f.block(41);
  await until(() => f.acks.length === 2);
  expect((await f.checkpoint()).nextHeight).toBe(41);
  f.acks[1]!.socket.terminate();
  await until(() => f.cursors.length === 2, "reconnect after 2 second delay");
  expect(f.cursors).toEqual([{ from: "tip" }, { from: "height", height: 41 }]);
  await f.acknowledged(41);
  await f.acknowledged(42);
  await f.files([40, 41, 42]);
}, 10000);

it("replays a written block after a process dies with its ACK pending", async () => {
  const f = await fixture();
  const { child } = f.start();
  await until(() => f.cursors.length === 1);
  await f.acknowledged(40);
  f.block(41);
  await until(() => f.acks.length === 2);
  await f.files([40, 41]);
  const saved = (await f.checkpoint()).nextHeight;
  expect(saved).toBe(41);
  kill(child);
  await until(() => child.signalCode !== null, "child exit");
  f.start();
  await until(() => f.cursors.length === 2);
  expect(f.cursors[1]).toEqual({ from: "height", height: saved });
  await f.acknowledged(41);
  await f.acknowledged(42);
  await f.files([40, 41, 42]);
}, 10000);

it("exits with code 1 when the subscription is below the replay window", async () => {
  const f = await fixture();
  const running = f.start();
  await until(() => f.cursors.length === 1);
  f.notify({ type: "closed", reason: "below_window", subscriberId: 1 });
  await until(() => running.child.exitCode !== null, "fatal exit");
  expect(running.child.exitCode).toBe(1);
  expect(running.output()).toContain("below_window");
  expect(f.cursors).toHaveLength(1);
}, 10000);
