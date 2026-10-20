import { toBase58 } from "@thruputchain/client";
import type { GlobalConfig } from "@/config";

export async function withAccountLock<T>(
  config: Pick<GlobalConfig, "networkId" | "accountAddress">,
  action: () => Promise<T> | T,
): Promise<T> {
  if (typeof window === "undefined" || window.navigator.locks === undefined) {
    throw new Error(
      "This browser must support Web Locks for safe local signing",
    );
  }
  const name = [
    "groundhog-swap:account-lock:v1",
    config.networkId,
    toBase58(config.accountAddress),
  ].join(":");
  return window.navigator.locks.request(name, { mode: "exclusive" }, action);
}
