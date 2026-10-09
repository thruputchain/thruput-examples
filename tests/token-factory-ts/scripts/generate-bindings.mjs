import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harness = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(harness, "../..");
const artifactRoot = resolve(
  process.env.GROUNDHOG_ARTIFACT_ROOT ?? resolve(repository, "target/groundhog"),
);
const groundhog = process.env.GROUNDHOG ?? "groundhog";

const version = execFileSync(groundhog, ["--version"], { encoding: "utf8" }).trim();
execFileSync("bash", [resolve(repository, "scripts/check-groundhog-version.sh"), version], {
  stdio: "inherit",
});

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
