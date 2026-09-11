// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { durableMkdir } from "./seed-journal.ts";

const fs = vi.hoisted(() => ({
  operations: [] as string[],
  existing: false,
  failSync: "",
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: async (path: string) => {
    fs.operations.push(`mkdir:${path}`);
    if (fs.existing)
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
  },
  open: async (path: string) => ({
    stat: async () => ({ isDirectory: () => true }),
    sync: async () => {
      fs.operations.push(`sync:${path}`);
      if (path === fs.failSync) throw new Error("parent fsync failed");
    },
    close: async () => {
      fs.operations.push(`close:${path}`);
    },
  }),
}));

describe("durable seed directory ancestry", () => {
  beforeEach(() => {
    fs.operations = [];
    fs.existing = false;
    fs.failSync = "";
  });

  it.each([false, true])(
    "syncs every parent entry, including interrupted existing directories (%s)",
    async (existing) => {
      fs.existing = existing;
      await durableMkdir("/seed-test/state/scope");
      const paths = [
        "/seed-test",
        "/seed-test/state",
        "/seed-test/state/scope",
      ];
      const parents = ["/", "/seed-test", "/seed-test/state"];
      for (const [index, path] of paths.entries()) {
        const created = fs.operations.indexOf(`mkdir:${path}`);
        const synced = fs.operations.indexOf(`sync:${parents[index]}`, created);
        expect(synced).toBeGreaterThan(created);
        if (paths[index + 1])
          expect(synced).toBeLessThan(
            fs.operations.indexOf(`mkdir:${paths[index + 1]}`),
          );
      }
    },
  );

  it("propagates a parent fsync failure before any signer/manifest submission can proceed", async () => {
    fs.failSync = "/";
    const next = vi.fn();
    await expect(
      durableMkdir("/seed-test/state/scope").then(next),
    ).rejects.toThrow("parent fsync failed");
    expect(next).not.toHaveBeenCalled();
    expect(fs.operations).not.toContain("mkdir:/seed-test/state");
    expect(fs.operations).toContain("close:/");
  });
});
