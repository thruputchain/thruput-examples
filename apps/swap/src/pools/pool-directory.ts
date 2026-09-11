import type { AppConfig } from "@/config";
import type { PoolSnapshot } from "@/swap/snapshot";

export interface PoolDirectoryEntry {
  config: AppConfig;
  snapshot: PoolSnapshot;
}
