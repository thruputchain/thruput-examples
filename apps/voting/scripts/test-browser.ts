import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import {
  createPubkeyAccount,
  createWalletClient,
  PrivateKeySigner,
  toBase58,
  toHex0x,
  signTransaction,
  hashSignedTransaction,
  serializeSignedTransaction,
} from "@thruputchain/client";
import {
  parseProviderRequest,
  parseTransactionHex,
  parseSignedTransactionHex,
  type WalletAccount,
} from "@thruputchain/client/provider";
import { localClient, deployVoting } from "./setup-local";

const client = await localClient();
const address = await deployVoting(client);
const signers = [
  new PrivateKeySigner(randomBytes(32)),
  new PrivateKeySigner(randomBytes(32)),
];
const accounts: WalletAccount[] = [];
for (const signer of signers) {
  const account = createPubkeyAccount({ signer });
  assert.equal(
    (await createWalletClient({ client, account }).requestAirdrop()).status
      .result,
    "ok",
  );
  accounts.push({
    address: toBase58(account.address),
    publicKey: toBase58(signer.publicKey.ed25519),
    nonce: "0",
  });
}
const network = toBase58(client.network.networkHash);
const evidence = fileURLToPath(
  new URL("../../../.local/voting-browser/", import.meta.url),
);
await mkdir(evidence, { recursive: true });
process.env.VITE_THRUPUT_NETWORK_ID = network;
process.env.VITE_VOTING_ADDRESS = toBase58(address);
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { port: 0, host: "127.0.0.1" },
});
await server.listen();
const socket = server.httpServer!.address();
assert.ok(socket && typeof socket !== "string");
const browser = await chromium
  .launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => void dialog.accept());
let signatures = 0;
try {
  await page.exposeFunction("votingWalletRequest", async (input: unknown) => {
    const request = parseProviderRequest(input);
    if (request.method === "signTransaction") {
      const index = accounts.findIndex(
        (a) => a.address === request.params.account,
      );
      assert.ok(index >= 0);
      const signed = await signTransaction(
        parseTransactionHex(request.params.transaction),
        [{ signer: signers[index]!, publicKeyId: 0n }],
        client.network.networkHash,
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
          await client.sendTransaction(
            parseSignedTransactionHex(request.params.signedTransaction),
          ),
        ),
      };
    throw new Error("Unexpected provider request");
  });
  await page.addInitScript({
    content: `(() => {
    const accounts = ${JSON.stringify(accounts)};
    const networkHash = ${JSON.stringify(network)};
    let session = { networkHash, accounts: [] };
    const listeners = new Set();
    const change = next => { session = next; listeners.forEach(f => f(session)); };
    const provider = { info: { id: "voting-test", name: "Voting test wallet", version: "2.0.0" },
      on(event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async request(request) {
        if (request.method === "connect") { change({ networkHash, accounts }); return session; }
        if (request.method === "getSession") return session;
        if (request.method === "disconnect") { change({ networkHash, accounts: [] }); return null; }
        if (request.method === "getCapabilities") throw { code: 4200, message: "No batching" };
        return window.votingWalletRequest(request);
      }
    };
    const announce = () => window.dispatchEvent(new CustomEvent("groundhog:announceProvider", { detail: provider }));
    window.addEventListener("groundhog:requestProvider", announce); announce();
  })();`,
  });
  const origin = `http://127.0.0.1:${socket.port}`;
  await page.goto(origin);
  await page.getByRole("heading", { name: "Community polls" }).waitFor();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByRole("link", { name: "Create poll", exact: true }).click();
  await page
    .getByLabel("Poll title", { exact: true })
    .fill("Developer priorities");
  await page.getByLabel("Question text", { exact: true }).fill("What next?");
  await page.getByLabel("Option 1", { exact: true }).fill("Wallet");
  await page.getByLabel("Option 2", { exact: true }).fill("Explorer");
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  const second = page.getByRole("region", { name: "Question 2", exact: true });
  await second.getByLabel("Question text", { exact: true }).fill("When?");
  await second.getByLabel("Option 1", { exact: true }).fill("Monday");
  await second.getByLabel("Option 2", { exact: true }).fill("Friday");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const confirmed = page.getByText("Confirmed on-chain.", { exact: true });
  await confirmed.waitFor({ timeout: 60_000 });
  const beforeReload = signatures;
  await page.reload();
  await confirmed.waitFor({ timeout: 60_000 });
  assert.equal(signatures, beforeReload, "Reload must observe, not sign again");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await confirmed.waitFor({ state: "hidden" });
  await page.goto(`${origin}/admin`);
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page
    .getByRole("link")
    .filter({
      has: page.getByRole("heading", { name: "Developer priorities" }),
    })
    .click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByLabel("Description (optional)")
    .fill("Choose our next development priority.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await confirmed.waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await confirmed.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "View draft", exact: true }).click();
  await page.getByRole("button", { name: "Open poll", exact: true }).click();
  await confirmed.waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByRole("radio", { name: "Wallet", exact: true }).check();
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await confirmed.waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByText("Your answer is confirmed and cannot change.").waitFor();
  assert.equal(
    await page
      .getByRole("radio", { name: "Explorer", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("combobox", { name: "Wallet account" })
    .selectOption(accounts[1]!.address);
  await page.getByRole("radio", { name: "Explorer", exact: true }).check();
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await confirmed.waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByText("2 participants", { exact: true }).waitFor();
  await page
    .getByRole("navigation", { name: "Questions", exact: true })
    .getByRole("button", { name: "2", exact: true })
    .click();
  await page.getByRole("radio", { name: "Friday", exact: true }).check();
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await confirmed.waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Wallet account" })
    .selectOption(accounts[0]!.address);
  await page.getByRole("button", { name: "Close poll", exact: true }).click();
  await confirmed.waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByText("This poll is closed. The results are final.").waitFor();
  await page.reload();
  await page.getByText("This poll is closed. The results are final.").waitFor();
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `Overflow at ${width}`,
      );
      await page.screenshot({
        path: join(evidence, `${colorScheme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.screenshot({
    path: join(evidence, "desktop.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    `Voting browser checks passed (${signatures} wallet signatures).`,
  );
} catch (error) {
  console.error(
    "Visible alerts:",
    await page.getByRole("alert").allTextContents(),
  );
  await page.screenshot({
    path: join(evidence, "failure.png"),
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
