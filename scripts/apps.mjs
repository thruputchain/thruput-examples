import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFile, lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const apps = ["counter", "token-launchpad", "swap", "voting", "airdrop"];
const command = process.argv[2];
if (command !== "setup:local" && command !== "dev") {
  throw new Error("Use setup:local or dev.");
}

const children = new Set();
let stopping = false;
function stop(signal = "SIGTERM") {
  stopping = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop());

function run(app) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", command, "--workspace", `apps/${app}`], {
      cwd: root,
      stdio: "inherit",
      detached: true,
    });
    children.add(child);
    child.once("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (stopping || (command === "setup:local" && code === 0)) resolve();
      else reject(new Error(`${app} exited with ${signal ?? code}`));
    });
  });
}

try {
  if (command === "setup:local") {
    for (const path of [
      process.env.AIRDROP_ENV_PATH || "apps/airdrop/.env.local",
      process.env.AIRDROP_SETUP_DIR || "apps/airdrop/.local/local",
    ]) {
      try {
        await lstat(resolve(root, path));
        throw new Error(
          `Preserve the existing airdrop deployment at ${path} and select fresh setup paths before running setup:local.`,
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!process.env.THRUPUT_RUNTIME_MANIFEST)
      throw new Error(
        "Start thruput node, then set THRUPUT_RUNTIME_MANIFEST to its printed manifest path.",
      );
    if (!process.env.THRUPUT_CLI)
      throw new Error("Set THRUPUT_CLI to the CLI executable.");
    console.log(
      "Setting up five apps and fresh airdrop assets on the local node.",
    );
    for (const app of apps) {
      if (stopping) break;
      await run(app);
    }
    if (!stopping) {
      const launchpadPath = resolve(
        root,
        process.env.LAUNCHPAD_APP_ENV || "apps/token-launchpad/.env.local",
      );
      const swapPath = resolve(
        root,
        process.env.SWAP_APP_ENV || "apps/swap/.env.local",
      );
      const launchpad = parseEnv(await readFile(launchpadPath, "utf8"));
      const swap = parseEnv(await readFile(swapPath, "utf8"));
      if (launchpad.VITE_THRUPUT_NETWORK_ID !== swap.VITE_THRUPUT_NETWORK_ID)
        throw new Error("Launchpad and Swap must use the same local network.");
      await appendFile(
        launchpadPath,
        "\nVITE_SWAP_APP_URL=http://127.0.0.1:5174\n",
      );
      await appendFile(
        swapPath,
        [
          "",
          "VITE_TOKEN_DISCOVERY_ENABLED=true",
          `VITE_STANDARD_TOKEN_FACTORY_ADDRESS=${launchpad.VITE_STANDARD_TOKEN_FACTORY_ADDRESS}`,
          `VITE_STANDARD_TOKEN_HASH=${launchpad.VITE_STANDARD_TOKEN_HASH}`,
          "TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://127.0.0.1:5173",
          "",
        ].join("\n"),
      );
    }
  } else {
    console.log(
      "Counter :5175 · Launchpad :5173 · Swap :5174 · Voting :5176 · Airdrop :5177",
    );
    await Promise.all(apps.map(run));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  stop();
}
