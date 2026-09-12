import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindPoolScope, seedDirectory } from "./seed-scope.ts";

const scope = { network: "network", factory: "tokens", tokenHash: "code" };
const pool = { swapFactory: "pools", router: "router", poolHash: "lp" };
const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "seed-scope-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("seed scope migration", () => {
  it.each(["", "{}", JSON.stringify({ scope: "{}" })])(
    "refuses a damaged journal rather than starting another run (%j)",
    async (text) => {
      const path = await root();
      const directory = join(path, "a".repeat(64));
      await mkdir(directory);
      await writeFile(join(directory, "manifest.json"), text);
      await expect(seedDirectory(path, scope)).rejects.toThrow(
        "Unreadable seed journal",
      );
    },
  );
  it("selects a stable token-only directory before any Swap setup exists", async () => {
    const path = join(await root(), "not-created");
    expect(await seedDirectory(path, scope)).toBe(
      await seedDirectory(path, { ...scope }),
    );
    expect(await seedDirectory(path, scope)).not.toBe(
      await seedDirectory(path, { ...scope, factory: "other" }),
    );
  });

  it("reuses a legacy journal without changing its transaction evidence", async () => {
    const path = await root();
    const directory = join(path, "a".repeat(64));
    await mkdir(directory);
    const original = JSON.stringify({
      scope: JSON.stringify({ ...scope, ...pool }),
      steps: { create: [{ hash: "original" }] },
    });
    await writeFile(join(directory, "manifest.json"), original);
    expect(await seedDirectory(path, scope)).toBe(directory);
    expect(await readFile(join(directory, "manifest.json"), "utf8")).toBe(
      original,
    );
  });

  it("rejects ambiguous legacy runs rather than choosing or creating another", async () => {
    const path = await root();
    for (const name of ["a", "b"]) {
      const directory = join(path, name.repeat(64));
      await mkdir(directory);
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify({
          scope: JSON.stringify({ ...scope, ...pool, router: name }),
        }),
      );
    }
    await expect(seedDirectory(path, scope)).rejects.toThrow(
      "Multiple seed journals",
    );
  });

  it("binds a new token journal to its first pool setup and refuses later changes", () => {
    const state = { scope: JSON.stringify(scope) };
    bindPoolScope(state, pool);
    expect(state).toHaveProperty("poolScope", pool);
    expect(() =>
      bindPoolScope(state, { ...pool, router: "different" }),
    ).toThrow("pool scope mismatch");
    expect(state).toHaveProperty("poolScope", pool);
  });

  it("preserves the Swap binding of a legacy journal", () => {
    const state = { scope: JSON.stringify({ ...scope, ...pool }) };
    bindPoolScope(state, pool);
    expect(state).not.toHaveProperty("poolScope");
    expect(() =>
      bindPoolScope(state, { ...pool, swapFactory: "different" }),
    ).toThrow("pool scope mismatch");
  });
});
