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
const expectedVersion = "groundhog 0.10.4";
const expectedHashes = {
  "standard_token.rv32a": "29acf5132fa8fb5798058e40c1f53532ae4b41ae42f8f070fb493bbebb9060b6",
  "standard_token.spec.xdr": "b41c5d5d996a6bf6b8e8f8e1781357ebb825e6ebd2359a475021bc1bc4c9bb9b",
  "standard_token_factory.rv32a": "9f2be416c7f822b7f59142bcef75e362735f604368ae0a7723a336079c779ebd",
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
