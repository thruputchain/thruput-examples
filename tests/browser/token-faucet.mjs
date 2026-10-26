import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import {
  createPubkeyAccount,
  Ed25519Signer,
  toBase58,
} from "@thruputchain/client";

// This test submits one real claim. Use an isolated local faucet deployment.
const url = new URL(process.env.FAUCET_TEST_URL || "http://127.0.0.1:5177/");
assert(
  url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname),
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url.href);
  await page.getByRole("heading", { name: "Claim test tokens" }).waitFor();
  assert.equal(await page.locator(".intro, .eyebrow").count(), 0);
  const recipient = createPubkeyAccount({
    signer: new Ed25519Signer(randomBytes(32)),
  });
  await page.getByLabel("Wallet address").fill(toBase58(recipient.address));
  await page.getByRole("button", { name: "Get starter pack" }).click();
  await page.getByText(/^Claim: /).waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "Your tokens are ready" })
    .waitFor({ timeout: 60_000 });
  assert.equal(
    await page.getByLabel("Wallet address").inputValue(),
    toBase58(recipient.address),
  );
  assert.equal(await page.locator(".pack li").count(), 6);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `Overflow at ${width}px`,
    );
  }
  assert.deepEqual(errors, []);
  const recovery = await browser.newPage();
  const canonicalId = randomUUID();
  let attempts = 0;
  const canonical = {
    id: canonicalId,
    recipient: toBase58(recipient.address),
    status: "pending",
    hash: null,
    createdAt: Date.now(),
    retryAt: Date.now() + 86400000,
  };
  await recovery.route("**/api/claims", async (route) => {
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 429,
        json: { error: "Test claim limit reached." },
      });
    if (attempts === 2) return route.abort("failed");
    return route.fulfill({ status: 202, json: canonical });
  });
  await recovery.route("**/api/claims/*", (route) =>
    route.fulfill({
      status: route.request().url().endsWith(canonicalId) ? 200 : 404,
      json: route.request().url().endsWith(canonicalId)
        ? canonical
        : { error: "Claim not found." },
    }),
  );
  await recovery.goto(url.href);
  await recovery.getByLabel("Wallet address").fill(canonical.recipient);
  await recovery.getByRole("button", { name: "Get starter pack" }).click();
  await recovery
    .getByRole("alert")
    .filter({ hasText: "Test claim limit reached." })
    .waitFor();
  assert(await recovery.getByLabel("Wallet address").isEnabled());
  await recovery.getByRole("button", { name: "Get starter pack" }).click();
  await recovery
    .getByRole("button", { name: "Check or recover claim" })
    .waitFor();
  assert(await recovery.getByLabel("Wallet address").isDisabled());
  await recovery
    .getByRole("button", { name: "Check or recover claim" })
    .click();
  await recovery.getByText(`Claim: ${canonicalId}`, { exact: true }).waitFor();
  await recovery.reload();
  await recovery.getByText(`Claim: ${canonicalId}`, { exact: true }).waitFor();
  console.log(
    "Faucet browser claim, rejection handling, recovery, and responsive layouts passed.",
  );
} finally {
  await browser.close();
}
