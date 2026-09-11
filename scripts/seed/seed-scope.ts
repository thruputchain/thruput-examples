import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SeedError } from "./seed-journal.ts";

export interface TokenScope {
  network: string;
  factory: string;
  tokenHash: string;
}

export interface PoolScope {
  swapFactory: string;
  router: string;
  poolHash: string;
}

// Older journals included Swap in their directory digest. Find and reuse them
// before creating token-only state, so upgrading never creates duplicate tokens.
export async function seedDirectory(
  root: string,
  scope: TokenScope,
): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    const text = await readFile(join(directory, "manifest.json"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (text === undefined) continue;
    let saved: TokenScope;
    try {
      saved = JSON.parse(JSON.parse(text).scope) as TokenScope;
      if (
        !saved ||
        typeof saved.network !== "string" ||
        typeof saved.factory !== "string" ||
        typeof saved.tokenHash !== "string"
      )
        throw new Error("Invalid scope");
    } catch {
      throw new SeedError(
        "Unreadable seed journal scope; preserve existing state and repair it before seeding",
      );
    }
    if (
      saved.network === scope.network &&
      saved.factory === scope.factory &&
      saved.tokenHash === scope.tokenHash
    )
      matches.push(directory);
  }
  if (matches.length > 1)
    throw new SeedError(
      "Multiple seed journals match this token factory. Preserve them and resolve the duplicate runs before seeding.",
    );
  return (
    matches[0] ??
    join(root, createHash("sha256").update(JSON.stringify(scope)).digest("hex"))
  );
}

export function bindPoolScope(
  state: { scope: string; poolScope?: PoolScope },
  expected: PoolScope,
): void {
  const legacy = JSON.parse(state.scope) as Partial<PoolScope>;
  const saved = state.poolScope ?? (legacy.swapFactory ? legacy : undefined);
  if (
    saved &&
    (saved.swapFactory !== expected.swapFactory ||
      saved.router !== expected.router ||
      saved.poolHash !== expected.poolHash)
  ) {
    throw new SeedError(
      "Seed pool scope mismatch; resume against the original Swap infrastructure",
    );
  }
  if (!saved) state.poolScope = expected;
}
