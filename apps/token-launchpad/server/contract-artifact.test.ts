// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { hashContract, toBase58 } from "@thruputchain/client";
import { ContractType } from "@thruputchain/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { validateStandardTokenArtifact } from "./contract-artifact";

const hash = toBase58(
  hashContract({
    contract_type: ContractType.kRv32,
    rv32_contract: { data: new Uint8Array([1, 2, 3]) },
  }),
);
const artifact = { contractType: "rv32", data: "0x010203", hash };
let directory: string;
let filename: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "launchpad-artifact-"));
  await mkdir(path.join(directory, "contract-artifacts"));
  filename = path.join(directory, "contract-artifacts", `${hash}.json`);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("validates the exact served immutable artifact", async () => {
  await writeFile(filename, JSON.stringify(artifact));
  await expect(
    validateStandardTokenArtifact(directory, hash),
  ).resolves.toBeUndefined();
});
it("requires the hash-qualified artifact filename", async () => {
  await writeFile(
    path.join(directory, "contract-artifacts/standard-token.json"),
    JSON.stringify(artifact),
  );
  await expect(validateStandardTokenArtifact(directory, hash)).rejects.toThrow(
    /missing/,
  );
});
it.each([
  "{",
  "{}",
  JSON.stringify({ ...artifact, extra: true }),
  JSON.stringify({ ...artifact, data: "0x040506" }),
  JSON.stringify({
    ...artifact,
    hash: toBase58(new Uint8Array(32).fill(0x11)),
  }),
])("rejects invalid bytes or schema %s", async (contents) => {
  await writeFile(filename, contents);
  await expect(
    validateStandardTokenArtifact(directory, hash),
  ).rejects.toThrow();
});
it("rejects oversized files", async () => {
  await writeFile(filename, new Uint8Array(8 * 1024 * 1024 + 1));
  await expect(validateStandardTokenArtifact(directory, hash)).rejects.toThrow(
    /too large/,
  );
});
it("rejects paths outside the served root", async () => {
  await symlink(path.join(directory, ".."), filename);
  await expect(validateStandardTokenArtifact(directory, hash)).rejects.toThrow(
    /inside/,
  );
});
