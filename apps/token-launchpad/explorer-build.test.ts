// @vitest-environment node
import { build } from "vite";
import { expect, it, vi } from "vitest";

it("builds without deployment configuration and does not embed environment values", async () => {
  vi.stubEnv("VITE_EXPLORER_URL", "https://private-build-value.test");
  vi.stubEnv("VITE_THRUPUT_RPC_URL", "https://private-upstream.test");
  try {
    const result = await build({ mode: "production", publicDir: false, logLevel: "silent", build: { write: false } });
    if (!("output" in result)) throw new Error("Expected one bundle");
    const code = result.output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n");
    expect(code).not.toContain("private-build-value");
    expect(code).not.toContain("private-upstream");
    expect(code).toContain("/api/config");
    expect(result.output.some((item) => item.fileName === "groundhog-public-config.json")).toBe(false);
  } finally { vi.unstubAllEnvs(); }
}, 30_000);
