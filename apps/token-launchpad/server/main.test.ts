// @vitest-environment node
import { expect, it, vi } from "vitest";
import { validateStandardTokenArtifact } from "./contract-artifact";
import { createThruputRegistrySource } from "./chain";

vi.mock("./config.ts", () => ({
  loadServerConfig: () => ({
    scope: { tokenCodeHash: `0x${"11".repeat(32)}` },
  }),
}));
vi.mock("./contract-artifact.ts", () => ({
  validateStandardTokenArtifact: vi
    .fn()
    .mockRejectedValue(new Error("Required artifact is missing")),
}));
vi.mock("./chain.ts", () => ({ createThruputRegistrySource: vi.fn() }));
it("validates dist before connecting to RPC or opening the database", async () => {
  await expect(import("./main")).rejects.toThrow(/artifact is missing/);
  expect(validateStandardTokenArtifact).toHaveBeenCalledWith(
    expect.stringMatching(/token-launchpad\/dist$/),
    `0x${"11".repeat(32)}`,
  );
  expect(createThruputRegistrySource).not.toHaveBeenCalled();
});
