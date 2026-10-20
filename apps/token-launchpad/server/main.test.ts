// @vitest-environment node

import { toBase58 } from "@thruputchain/client";
import { expect, it, vi } from "vitest";
import { validateStandardTokenArtifact } from "./contract-artifact";
import { createThruputRegistrySource } from "./chain";

vi.mock("./config.ts", () => ({
  loadServerConfig: () => ({
    scope: { tokenCodeHash: toBase58(new Uint8Array(32).fill(0x11)) },
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
    toBase58(new Uint8Array(32).fill(0x11)),
  );
  expect(createThruputRegistrySource).not.toHaveBeenCalled();
});
