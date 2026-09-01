import { spawn } from "node:child_process";

const child = spawn("bash", ["scripts/test-clean-ledger.sh"], {
  cwd: new URL("..", import.meta.url),
  detached: true,
  env: { ...process.env, GAME_OF_LIFE_DEV_SERVER: "1" },
  stdio: "inherit",
});

let stopping = false;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
process.once("SIGHUP", () => stop(129));

child.once("error", (error) => {
  console.error(`Failed to start the local stack: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
});
