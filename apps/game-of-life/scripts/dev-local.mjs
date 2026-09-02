import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "../..");
const children = new Set();
let stopping = false;
let requestedExitCode = null;

for (const [signal, exitCode] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    requestedExitCode = exitCode;
    void stopChildren().then(() => {
      process.exitCode = exitCode;
    });
  });
}

async function main() {
  const environment = await loadEnvironment();
  const rpcUrl = localOrigin(
    required(environment, "VITE_GROUNDHOG_RPC_URL"),
    "VITE_GROUNDHOG_RPC_URL",
  );
  const indexerUrl = localOrigin(
    required(environment, "VITE_GAME_OF_LIFE_INDEXER_URL"),
    "VITE_GAME_OF_LIFE_INDEXER_URL",
  );
  const appUrl = localOrigin(
    environment.GAME_OF_LIFE_APP_URL ?? "http://127.0.0.1:5173",
    "GAME_OF_LIFE_APP_URL",
  );
  const networkId = required(environment, "VITE_GROUNDHOG_NETWORK_ID");
  const contractAddress = required(
    environment,
    "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS",
  );
  if (!/^(?:0x)?[0-9a-f]{64}$/.test(networkId))
    throw new Error("VITE_GROUNDHOG_NETWORK_ID must be lowercase hex32");
  if (!/^0x[0-9a-f]{64}$/.test(contractAddress))
    throw new Error(
      "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS must be canonical lowercase hex32",
    );

  await runBuild();
  if (stopping) return;

  const indexerBinary = resolve(
    environment.GAME_OF_LIFE_INDEXER_BINARY ??
      join(repoRoot, "target/release/game-of-life-indexer"),
  );
  const indexer = startChild(indexerBinary, [], {
    cwd: repoRoot,
    env: {
      ...environment,
      GROUNDHOG_RPC_URL: rpcUrl.href,
      GROUNDHOG_NETWORK_ID: networkId.replace(/^0x/, ""),
      GROUNDHOG_CONTRACT_ADDRESS: contractAddress,
      GAME_OF_LIFE_ARTIFACT_ROOT:
        environment.GAME_OF_LIFE_ARTIFACT_ROOT ??
        join(repoRoot, "tmp/game-of-life-indexer/artifacts"),
      GAME_OF_LIFE_INDEXER_DB:
        environment.GAME_OF_LIFE_INDEXER_DB ??
        join(repoRoot, "tmp/game-of-life-indexer/indexer.sqlite3"),
      GAME_OF_LIFE_INDEXER_LISTEN: socketAddress(indexerUrl),
      GAME_OF_LIFE_CORS_ORIGINS: appUrl.origin,
    },
    name: "indexer",
  });
  const vite = startChild(
    join(appDir, "node_modules/.bin/vite"),
    ["--host", listenHost(appUrl), "--port", appUrl.port, "--strictPort"],
    { cwd: appDir, env: environment, name: "Vite" },
  );

  const latestUrl = new URL(
    `/v1/worlds/${networkId.replace(/^0x/, "")}/${contractAddress}/latest.json`,
    indexerUrl,
  );
  await Promise.race([
    Promise.all([
      waitForHttp(appUrl, "Vite"),
      waitForHttp(latestUrl, "the first index publication"),
    ]),
    unexpectedExit(indexer),
    unexpectedExit(vite),
  ]);
  if (stopping) return;

  process.stdout.write(
    `\nGame of Life development services are ready:\n` +
      `  App:     ${appUrl.origin}\n` +
      `  Indexer: ${indexerUrl.origin}\n` +
      `  RPC:     ${rpcUrl.origin}\n` +
      "Press Ctrl-C to stop the application services.\n",
  );

  const exited = await Promise.race([indexer.exited, vite.exited]);
  if (!stopping) {
    throw new Error(
      `${exited.name} exited unexpectedly${describeExit(exited)}`,
    );
  }
}

async function loadEnvironment() {
  const path = join(appDir, ".env.local");
  const metadata = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT")
      throw new Error(`Run setup:local first; ${path} does not exist`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${path} must be a regular, non-symlinked file`);
  return { ...parseEnv(await readFile(path, "utf8")), ...process.env };
}

async function runBuild() {
  process.stdout.write("Building the Game of Life indexer...\n");
  const cargo = startChild(
    "cargo",
    ["build", "-p", "game-of-life-indexer", "--release", "--locked"],
    { cwd: repoRoot, env: process.env, name: "indexer build" },
  );
  const result = await cargo.exited;
  children.delete(cargo);
  if (!stopping && result.code !== 0)
    throw new Error(`Indexer build failed${describeExit(result)}`);
}

function startChild(command, args, { cwd, env, name }) {
  const processHandle = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const child = {
    name,
    process: processHandle,
    exited: new Promise((resolveExit, rejectExit) => {
      processHandle.once("error", rejectExit);
      processHandle.once("exit", (code, signal) =>
        resolveExit({ name, code, signal }),
      );
    }),
  };
  children.add(child);
  return child;
}

async function unexpectedExit(child) {
  const result = await child.exited;
  if (!stopping)
    throw new Error(
      `${result.name} exited before readiness${describeExit(result)}`,
    );
}

async function waitForHttp(url, description) {
  const deadline = Date.now() + 600_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Services may refuse connections while starting.
    }
    await wait(250);
  }
  if (!stopping)
    throw new Error(`Timed out waiting for ${description} at ${url}`);
}

async function stopChildren() {
  if (stopping) return;
  stopping = true;
  const active = [...children];
  for (const child of active) signalChild(child.process.pid, "SIGTERM");
  await Promise.race([
    Promise.allSettled(active.map(({ exited }) => exited)),
    wait(5_000),
  ]);
  for (const child of active) signalChild(child.process.pid, "SIGKILL");
  await Promise.allSettled(active.map(({ exited }) => exited));
  children.clear();
}

function signalChild(pid, signal) {
  if (!pid) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function localOrigin(value, name) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.port
  ) {
    throw new Error(
      `${name} must be a credential-free loopback HTTP origin with an explicit port`,
    );
  }
  return url;
}

function listenHost(url) {
  return url.hostname === "localhost"
    ? "127.0.0.1"
    : url.hostname.replace(/^\[(.*)\]$/, "$1");
}

function socketAddress(url) {
  const host = listenHost(url);
  return host.includes(":") ? `[${host}]:${url.port}` : `${host}:${url.port}`;
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required in .env.local`);
  return value;
}

function describeExit({ code, signal }) {
  if (code !== null) return ` with exit code ${code}`;
  if (signal) return ` from ${signal}`;
  return "";
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

try {
  await main();
} catch (error) {
  if (!stopping) console.error(error instanceof Error ? error.message : error);
  if (requestedExitCode === null) process.exitCode = 1;
} finally {
  await stopChildren();
  if (requestedExitCode !== null) process.exitCode = requestedExitCode;
}
