import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPubkeyAccount,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { afterEach, expect, it } from "vitest";
import { connectChain, loadFaucetAccount } from "./chain";

const bytes = new Uint8Array(32).fill(7);
const expected = createPubkeyAccount({ signer: new PrivateKeySigner(bytes) });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it.each([toHex0x(bytes), toHex0x(bytes).slice(2)])(
  "loads the server secret without requiring a key file (case %#)",
  async (secret) => {
    const account = await loadFaucetAccount("/missing/key", secret);
    expect(account.address).toEqual(expected.address);
  },
);

it.each(["", "bad-secret-value", "ab".repeat(31), "ab".repeat(33)])(
  "rejects invalid environment keys without falling back or including the value",
  async (secret) => {
    await expect(loadFaucetAccount("/missing/key", secret)).rejects.toThrow(
      "FAUCET_SIGNING_PRIVATE_KEY must be a 32-byte hexadecimal key.",
    );
  },
);

it("preserves the file fallback and its permission check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faucet-key-test-"));
  directories.push(directory);
  const keyPath = join(directory, "signer.key");
  await writeFile(keyPath, bytes, { mode: 0o600 });
  expect((await loadFaucetAccount(keyPath)).address).toEqual(expected.address);
  await chmod(keyPath, 0o644);
  await expect(loadFaucetAccount(keyPath)).rejects.toThrow("mode 0600");
});

it("refuses a secret for the wrong faucet account before contacting the network", async () => {
  await expect(
    connectChain(
      {
        account: `0x${"01".repeat(32)}`,
        rpcUrl: "https://unused.invalid",
        network: `0x${"02".repeat(32)}`,
      },
      "/missing/key",
      toHex0x(bytes),
    ),
  ).rejects.toThrow("Faucet signer does not match the deployment.");
});
