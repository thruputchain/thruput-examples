import { toHex0x } from "@groundhogchain/client";
import type { GlobalConfig } from "@/config";

export async function withAccountLock<T>(
  config: Pick<GlobalConfig, "networkIdHex" | "accountAddress">,
  action: () => Promise<T> | T,
): Promise<T> {
  if (typeof window === "undefined" || window.navigator.locks === undefined) {
    throw new Error("This browser must support Web Locks for safe local signing");
  }
  const name = ["groundhog-swap:account-lock:v1", config.networkIdHex, toHex0x(config.accountAddress)].join(":");
  return window.navigator.locks.request(name, { mode: "exclusive" }, action);
}
