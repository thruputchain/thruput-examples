import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harness = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(harness, "../..");
const artifactRoot = resolve(
  process.env.GROUNDHOG_ARTIFACT_ROOT ?? resolve(repository, "target/groundhog"),
);
const groundhog = process.env.GROUNDHOG ?? "groundhog";
const expectedVersion = "groundhog 0.9.6";
const expectedHashes = {
  "standard_token.rv32a": "8cc88befd6e6eddaad85761cfcdb442c866c0b967bd835ca980fec8bd7762daa",
  "standard_token.spec.xdr": "b41c5d5d996a6bf6b8e8f8e1781357ebb825e6ebd2359a475021bc1bc4c9bb9b",
  "standard_token_factory.rv32a": "0da52622c2b541e83f1e0672db3899a3c93425c8a272f74918af003ce5c81e57",
  "standard_token_factory.spec.xdr": "8dea7ddba284db46c8057e9a70b4083d17781e6c5d894d8f79efceb0f3f8a5bf",
};

const version = execFileSync(groundhog, ["--version"], { encoding: "utf8" }).trim();
if (version !== expectedVersion) {
  throw new Error(`Expected ${expectedVersion}, received ${version}`);
}

mkdirSync(resolve(harness, "generated"), { recursive: true });

for (const packageName of [
  "standard-token",
  "standard-token-factory",
  "token-factory-test-wallet",
]) {
  execFileSync(groundhog, ["build", "-p", packageName, "--", "--locked"], {
    cwd: repository,
    stdio: "inherit",
  });
}

for (const [filename, expected] of Object.entries(expectedHashes)) {
  const actual = createHash("sha256")
    .update(readFileSync(resolve(artifactRoot, filename)))
    .digest("hex");
  if (actual !== expected) {
    throw new Error(`Unexpected SHA-256 for ${filename}: ${actual}`);
  }
}

for (const [spec, output] of [
  ["standard_token_factory.spec.xdr", "standard-token-factory.ts"],
  ["standard_token.spec.xdr", "standard-token.ts"],
  ["token_factory_test_wallet.spec.xdr", "token-factory-test-wallet.ts"],
]) {
  execFileSync(
    groundhog,
    ["codegen", "ts", resolve(artifactRoot, spec), "--output", resolve(harness, "generated", output)],
    { stdio: "inherit" },
  );
}
