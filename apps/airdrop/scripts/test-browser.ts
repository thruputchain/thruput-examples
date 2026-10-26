import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import {
  createPubkeyAccount,
  createThruputClient,
  createWalletClient,
  Ed25519Signer,
  hashSignedTransaction,
  localnet,
  serializeSignedTransaction,
  signTransaction,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import {
  parseProviderRequest,
  parseSignedTransactionHex,
  parseTransactionHex,
} from "@thruputchain/client/provider";
import { networkHash, sha256Hash } from "@thruputchain/protocol";

const env = parseEnv(
  await readFile(process.env.AIRDROP_ENV_PATH || ".env.local", "utf8"),
);
Object.assign(process.env, env);
const url = new URL(env.THRUPUT_RPC_URL!);
assert(
  url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
);
const client = await createThruputClient({
  cluster: localnet({ rpcUrl: url.href }),
});
const signer = new Ed25519Signer(randomBytes(32));
const account = createPubkeyAccount({ signer });
await createWalletClient({ client, account }).requestAirdrop();
const accounts = [
  {
    address: toBase58(account.address),
    publicKey: toBase58(signer.publicKey.ed25519),
    nonce: "0",
  },
];
const network = toBase58(client.network.networkHash);
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const socket = server.httpServer!.address();
assert(socket && typeof socket !== "string");
const browser = await chromium
  .launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
let signatures = 0;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("airdropWalletRequest", async (input: unknown) => {
    const request = parseProviderRequest(input);
    if (request.method === "signTransaction") {
      assert.equal(request.params.account, accounts[0]!.address);
      assert.equal(request.params.networkHash, network);
      const signed = await signTransaction(
        parseTransactionHex(request.params.transaction),
        [{ signer, publicKeyId: 0n }],
        networkHash(sha256Hash(client.network.networkHash)),
      );
      signatures++;
      return {
        signedTransaction: toHex0x(serializeSignedTransaction(signed)),
        hash: toBase58(hashSignedTransaction(signed)),
      };
    }
    if (request.method === "submitTransaction")
      return {
        hash: toBase58(
          (
            await client.sendTransaction({
              signedTransaction: serializeSignedTransaction(
                parseSignedTransactionHex(request.params.signedTransaction),
              ),
            })
          ).transactionHash,
        ),
      };
    throw new Error("Unexpected wallet request");
  });
  await page.addInitScript({
    content: `(() => {
    const accounts = ${JSON.stringify(accounts)}, networkHash = ${JSON.stringify(network)};
    let session = { networkHash, accounts: [] }; const listeners = new Set();
    const change = next => { session = next; listeners.forEach(f => f(session)); };
    const provider = { info: { id: "airdrop-test", name: "Airdrop test wallet", version: "2.0.0" },
      on(event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async request(request) {
        if (request.method === "connect") { change({ networkHash, accounts }); return session; }
        if (request.method === "getSession") return session;
        if (request.method === "disconnect") { change({ networkHash, accounts: [] }); return null; }
        if (request.method === "getCapabilities") throw { code: 4200, message: "No batching" };
        return window.airdropWalletRequest(request);
      }
    };
    const announce = () => window.dispatchEvent(new CustomEvent("groundhog:announceProvider", { detail: provider }));
    window.addEventListener("groundhog:requestProvider", announce); announce();
  })();`,
  });
  await page.goto(`http://127.0.0.1:${socket.port}`);
  await page.getByRole("heading", { name: "Claim your airdrop" }).waitFor();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Claim airdrop", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Airdrop claimed", exact: true })
    .waitFor({ timeout: 60000 })
    .catch(async (error) => {
      console.error(await page.locator("main").innerText());
      throw error;
    });
  assert.equal(signatures, 1);
  await page.reload();
  await page
    .getByRole("heading", { name: "Airdrop claimed", exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(signatures, 1, "Reload must not sign another claim");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--signal")
          .trim(),
      ),
      "#fdda24",
    );
    assert.equal(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).backgroundColor,
      ),
      colorScheme === "light" ? "rgb(245, 245, 240)" : "rgb(10, 10, 10)",
    );
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "Wallet claim, reload recovery, Thruput light/dark colors, and responsive layouts passed.",
  );
} finally {
  await browser.close();
  await server.close();
}
