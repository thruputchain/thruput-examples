import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

function leaderIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Linux-only ownership registry: IDs enter exclusively through detached spawn,
// never through a process-name search or a caller-supplied PID.
export class OwnedProcessGroups {
  #groups = new Map();
  #spawned = 0;
  #exited = 0;

  constructor({ graceMs = 2000, killTimeoutMs = 3000 } = {}) {
    if (process.platform !== "linux") {
      throw new Error("Live tests require Linux process groups and /proc");
    }
    this.graceMs = graceMs;
    this.killTimeoutMs = killTimeoutMs;
  }

  spawn(command, args, options) {
    const child = spawn(command, args, { ...options, detached: true });
    if (!child.pid) return child;
    const group = { pgid: child.pid, identity: leaderIdentity(child.pid) };
    this.#groups.set(child, group);
    this.#spawned++;
    // A launcher closing its output does not imply its descendants exited.
    child.once("close", () => {
      try {
        this.#gone(child, group);
      } catch {
        // Keep ownership; stopAll will surface probe failures during cleanup.
      }
    });
    return child;
  }

  #gone(child, group) {
    if (this.#groups.get(child) !== group) return true;
    try {
      process.kill(-group.pgid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      this.#groups.delete(child);
      this.#exited++;
      return true;
    }
  }

  #signal(child, group, signal) {
    if (this.#gone(child, group)) return;
    const identity = leaderIdentity(group.pgid);
    if (identity !== null && identity !== group.identity) {
      throw new Error(
        `Owned group ${group.pgid} leader identity changed; refusing to signal`,
      );
    }
    try {
      process.kill(-group.pgid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      this.#gone(child, group);
    }
  }

  async #wait(child, group, timeout) {
    const deadline = Date.now() + timeout;
    do {
      if (this.#gone(child, group)) return true;
      await delay(25);
    } while (Date.now() < deadline);
    return this.#gone(child, group);
  }

  async stop(child) {
    const group = this.#groups.get(child);
    if (!group) return;
    group.stopping ??= (async () => {
      this.#signal(child, group, "SIGTERM");
      if (await this.#wait(child, group, this.graceMs)) return;
      this.#signal(child, group, "SIGKILL");
      if (!(await this.#wait(child, group, this.killTimeoutMs))) {
        throw new Error(
          `Owned process group ${group.pgid} still exists after SIGKILL`,
        );
      }
    })();
    try {
      await group.stopping;
    } catch (error) {
      group.stopping = undefined;
      throw error;
    }
  }

  async stopAll() {
    const results = await Promise.allSettled(
      [...this.#groups.keys()].map((child) => this.stop(child)),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(
        errors,
        errors.map((error) => error.message).join("; "),
      );
    if (this.#groups.size)
      throw new Error("Owned process groups remain after cleanup");
    return {
      spawned: this.#spawned,
      verifiedExited: this.#exited,
      remaining: this.#groups.size,
    };
  }
}
