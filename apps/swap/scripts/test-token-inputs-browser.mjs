import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { PrivateKeySigner, toHex0x } from "@groundhogchain/client";
import { createPubkeyAccount } from "@groundhogchain/client/wallet";

// UI-only fixtures: no ledger, wallet credentials, upstream service, or signing.
const hex = (byte) => `0x${byte.repeat(32)}`;
const a = hex("01");
const b = hex("02");
const scope = {
  networkId: "00".repeat(32),
  factoryAddress: hex("07"),
  tokenCodeHash: hex("08"),
};
Object.assign(process.env, {
  VITE_EXPLORER_URL: "https://explorer.example.test",
  VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:1",
  VITE_GROUNDHOG_NETWORK_ID: scope.networkId,
  VITE_POOL_TOKEN_HASH: hex("09"),
  VITE_SWAP_FACTORY_ADDRESS: hex("03"),
  VITE_SWAP_ROUTER_ADDRESS: hex("04"),
  VITE_NATIVE_HOG_ADDRESS: hex("05"),
  VITE_POOL_REGISTRY_ENABLED: "false",
  VITE_TOKEN_DISCOVERY_ENABLED: "true",
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: scope.factoryAddress,
  VITE_STANDARD_TOKEN_HASH: scope.tokenCodeHash,
  TOKEN_DISCOVERY_UPSTREAM_ORIGIN: "http://127.0.0.1:1",
});
const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 320, height: 740 },
    hasTouch: true,
  });
  // Only a public identity crosses into this UI fixture. It cannot sign or submit.
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(9));
  const account = createPubkeyAccount({ signer });
  await context.addInitScript((session) => {
    const provider = {
      info: { id: "ui.fixture", name: "UI fixture (cannot sign)", version: "1.0.0" },
      async request(request) {
        if (request.method === "connect" || request.method === "getSession") return session;
        if (request.method === "disconnect") return undefined;
        throw new Error("Signing and submission are forbidden in this UI fixture");
      },
      on() { return () => {}; },
    };
    const announce = () => window.dispatchEvent(new CustomEvent("groundhog:announceProvider", { detail: provider }));
    window.addEventListener("groundhog:requestProvider", announce);
    announce();
  }, { networkHash: scope.networkId, accounts: [{ address: toHex0x(account.address), publicKey: toHex0x(signer.publicKey.ed25519), nonce: "0" }] });
  const page = await context.newPage();
  await context.route("https://explorer.example.test/**", (route) => route.fulfill({ body: "Explorer fixture" }));
  const errors = [];
  const searches = [];
  let unavailable = false;
  let networkReads = 0;
  let checkingCreation = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/groundhog-rpc", async (route) => {
    const request = route.request().postDataJSON();
    if (!checkingCreation && request.method === "groundhog_view") {
      await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Directory is outside this UI fixture" } } });
      return;
    }
    assert.equal(
      request.method,
      "groundhog_networkInfo",
      "No contract reads or writes may follow a network mismatch",
    );
    networkReads += 1;
    await route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: request.id,
        result: { networkHash: hex("ff") },
      },
    });
  });
  await page.route("**/api/token-discovery*", async (route) => {
    searches.push(new URL(route.request().url()).searchParams.get("q") || "");
    await route.fulfill(
      unavailable
        ? {
            status: 502,
            json: { error: { code: "unavailable", message: "Unavailable" } },
          }
        : {
            json: {
              scope,
              tokens: [a, b].map((tokenAddress) => ({
                tokenAddress,
                creatorAddress: a,
                name: "Same token name",
                symbol: "SAME",
                decimals: 6,
              })),
              hasMore: false,
              historyLimited: true,
              syncState: "idle",
            },
          },
    );
  });
  const url = `${origin}/pools/new?tokenA=${a}`;
  await page.goto(origin);
  await page.getByRole("button", { name: "Connect UI fixture (cannot sign)", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Wallet provider" }).count(), 0);
  await page.getByRole("button", { name: "Disconnect" }).waitFor();
  checkingCreation = true;
  networkReads = 0;
  await page.evaluate((url) => {
    history.pushState({}, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, url);
  const selectedLink = page.getByRole("link", { name: `Selected token address: ${a} (opens explorer in a new tab)` });
  await selectedLink.waitFor();
  assert.equal(await selectedLink.getAttribute("href"), `https://explorer.example.test/address/${a}`);
  assert.equal(await selectedLink.getAttribute("rel"), "noopener noreferrer");
  await selectedLink.focus();
  await page.getByRole("tooltip").waitFor();
  assert.equal(await page.getByRole("tooltip").textContent(), a);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Full tooltip must fit the mobile viewport");
  const addresses = page.getByLabel("Contract address", { exact: true });
  await addresses.first().waitFor();
  assert.equal(await addresses.first().inputValue(), a);
  assert.equal(await addresses.nth(1).inputValue(), "");
  assert.deepEqual(
    await page
      .getByLabel("Initial amount", { exact: true })
      .evaluateAll((nodes) => nodes.map((node) => node.value)),
    ["", ""],
  );
  await page
    .getByText("RPC network mismatch. Check the connection and retry.")
    .waitFor();
  // Development StrictMode may start and abort the first mount's preview.
  assert.ok(networkReads >= 1 && networkReads <= 2);
  assert.equal(
    await page
      .getByRole("button", { name: "Review pool", exact: true })
      .isDisabled(),
    true,
  );
  const trigger = page.getByRole("button", {
    name: "Search tokens for Token B",
    exact: true,
  });
  await trigger.tap();
  const search = page.getByRole("combobox", {
    name: "Search tokens for Token B",
    exact: true,
  });
  await search.waitFor();
  assert.equal(
    await search.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByRole("dialog").getByRole("option").nth(1).waitFor();
  assert.equal(await page.locator('[role="option"] a, [role="option"] button, button a').count(), 0);
  const highlighted = page.getByRole("link", { name: `Highlighted token address: ${b} (opens explorer in a new tab)` });
  await highlighted.waitFor();
  await highlighted.focus();
  const [explorerPage] = await Promise.all([context.waitForEvent("page"), highlighted.press("Enter")]);
  await explorerPage.waitForURL(`https://explorer.example.test/address/${b}`);
  assert.equal(await addresses.nth(1).inputValue(), "", "Opening explorer must not choose the highlighted token");
  await explorerPage.close();
  await search.focus();
  assert.equal(searches[0], "");
  assert.equal(
    await page.getByRole("dialog").getByRole("option").first().getAttribute("aria-disabled"),
    "true",
  );
  await search.fill("creator-not-in-labels");
  await page.getByText("2 indexed suggestions.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("option").count(), 2);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "320px page must not overflow",
  );
  const bounds = await page.getByRole("dialog").boundingBox();
  assert.ok(
    bounds.x >= 0 && bounds.x + bounds.width <= 320,
    "Popover must fit the mobile viewport",
  );
  await search.press("Enter");
  assert.equal(await addresses.nth(1).inputValue(), b);
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Search tokens for Token B",
  );
  assert.equal(page.url(), url);
  await trigger.click();
  await search.press("Escape");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Search tokens for Token B",
  );

  unavailable = true;
  await trigger.click();
  await search.fill(hex("0a"));
  await page
    .getByText("Token discovery is unavailable. Try again or use an address.")
    .waitFor();
  await page
    .getByRole("option", { name: `Use address ${hex("0a")}`, exact: true })
    .tap();
  assert.equal(await addresses.nth(1).inputValue(), hex("0a"));
  assert.equal(page.url(), url);
  await page.setViewportSize({ width: 1280, height: 900 });
  await trigger.click();
  await search.waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS: Chromium ${browser.version()}; 320px touch and desktop layout, accessible keyboard search/focus return, duplicates, server filtering, manual outage fallback, preset/network guard, no URL writes or signing.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
