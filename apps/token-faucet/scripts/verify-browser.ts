import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  createPubkeyAccount,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { readManifest } from "../server/config.ts";
import { faucetServer } from "../server/http.ts";
import type { ClaimStatus } from "../src/domain.ts";

const manifest = await readManifest(resolve("deployments/devnet.json"));
const records = new Map<string, ClaimStatus>();
const server = faucetServer(
  manifest,
  {
    async status(token, address) {
      return records.get(`${address}/${token}`) ?? { state: "available" };
    },
    async claim(token, address) {
      const result: ClaimStatus = {
        state: "claimed",
        transactionHash: `0x${"12".repeat(32)}`,
      };
      records.set(`${address}/${token}`, result);
      return result;
    },
  },
  resolve("dist"),
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
});
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const signer = new PrivateKeySigner(
      new Uint8Array(32).fill(width === 1440 ? 3 : 4),
    );
    const account = createPubkeyAccount({ signer });
    const recipient = toHex0x(account.address);
    const session = {
      networkHash: manifest.network.replace(/^0x/, ""),
      accounts: [
        {
          address: recipient,
          publicKey: toHex0x(signer.publicKey.ed25519),
          nonce: "0",
        },
      ],
    };
    // Use plain browser JavaScript so tsx does not inject function-name helpers.
    await page.addInitScript({
      content: `
      const session = ${JSON.stringify(session)};
      const provider = {
        info: { id: "faucet.fixture", name: "Thruput Wallet", version: "1.0.0" },
        async request({ method }) {
          if (method === "connect") return session;
          throw new Error("Unexpected wallet request");
        },
        on() { return () => {}; }
      };
      const announce = () => window.dispatchEvent(new CustomEvent("groundhog:announceProvider", { detail: provider }));
      window.addEventListener("groundhog:requestProvider", announce);
      announce();
    `,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page
      .getByRole("heading", { name: "Token faucet", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("link", { name: "Open Swap" }).getAttribute("href"),
      manifest.swapUrl,
    );
    assert(
      await page
        .getByRole("button", { name: "Get all available tokens" })
        .isDisabled(),
    );
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Connect Wallet", exact: true })
      .click();
    await page
      .getByText("Wallet address copied. Check the recipient before claiming.")
      .waitFor();
    assert.equal(
      await page.getByLabel("Recipient address").inputValue(),
      recipient,
    );
    await page
      .getByRole("button", { name: "Get 10 ACORN", exact: true })
      .click();
    await page.getByRole("button", { name: "Claimed", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Get all available tokens" })
      .click();
    await page
      .getByRole("button", { name: "All tokens claimed", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Claimed", exact: true }).count(),
      5,
    );
    await page.reload();
    await page.getByLabel("Recipient address").fill(recipient);
    await page
      .getByRole("button", { name: "All tokens claimed", exact: true })
      .waitFor();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({
        path: resolve(process.env.SCREENSHOT_DIR, `token-faucet-${width}.png`),
        fullPage: true,
      });
    console.log(`Browser checks passed at ${width}px`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
