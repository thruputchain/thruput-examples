import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { PrivateKeySigner, toBase58, MockTransport } from "@thruputchain/client";
import { createPubkeyAccount } from "@thruputchain/client/wallet";

async function checkBrand(page) {
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => [...document.querySelectorAll("header img")].every((img) => img.complete && img.naturalWidth > 0));
      const state = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        sans: [...document.fonts].some((font) => font.family.includes("Inter Variable") && font.status === "loaded"),
        mono: [...document.fonts].some((font) => font.family.includes("Inconsolata Variable") && font.status === "loaded"),
        monoApplied: [...document.querySelectorAll(".font-mono")].some((element) =>
          element.checkVisibility() && getComputedStyle(element).fontFamily.includes("Inconsolata Variable")),
      }));
      assert.deepEqual(state, {
        overflow: false,
        background: colorScheme === "dark" ? "rgb(10, 10, 10)" : "rgb(245, 245, 240)",
        sans: true,
        mono: true,
        monoApplied: true,
      });
      const lockup = await page.locator('header a[aria-label$="homepage"]').evaluate((link) => {
        const image = link.querySelector("img").getBoundingClientRect();
        const name = link.querySelector("span");
        const bounds = name.getBoundingClientRect();
        return { fontSize: getComputedStyle(name).fontSize, aligned: Math.abs(image.y + image.height / 2 - bounds.y - bounds.height / 2) < 1 };
      });
      assert.deepEqual(lockup, { fontSize: width === 320 ? "17px" : "20px", aligned: true });
    }
  }
}

// UI-only fixtures: no ledger, wallet credentials, upstream service, or signing.
const id = (byte) => toBase58(new Uint8Array(32).fill(byte));
const a = id(0x01);
const b = id(0x02);
const scope = {
  networkId: id(0x00),
  factoryAddress: id(0x07),
  tokenCodeHash: id(0x08),
};
Object.assign(process.env, {
  VITE_EXPLORER_URL: "https://explorer.example.test",
  VITE_THRUPUT_RPC_URL: "http://127.0.0.1:1",
  VITE_THRUPUT_NETWORK_ID: scope.networkId,
  VITE_POOL_TOKEN_HASH: id(0x09),
  VITE_SWAP_FACTORY_ADDRESS: id(0x03),
  VITE_SWAP_ROUTER_ADDRESS: id(0x04),
  VITE_NATIVE_HOG_ADDRESS: id(0x05),
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
  VITE_TOKEN_DISCOVERY_ENABLED: "true",
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: scope.factoryAddress,
  VITE_STANDARD_TOKEN_HASH: scope.tokenCodeHash,
  TOKEN_DISCOVERY_UPSTREAM_ORIGIN: "http://127.0.0.1:1",
});
const server = await createServer({
  mode: "browser-test",
  root: fileURLToPath(new URL("../../apps/swap", import.meta.url)),
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
  await context.addInitScript(
    (session) => {
      const provider = {
        info: {
          id: "ui.fixture",
          name: "UI fixture (cannot sign)",
          version: "2.0.0",
        },
        async request(request) {
          if (request.method === "connect" || request.method === "getSession")
            return session;
          if (request.method === "disconnect") return undefined;
          throw new Error(
            "Signing and submission are forbidden in this UI fixture",
          );
        },
        on() {
          return () => {};
        },
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("groundhog:announceProvider", { detail: provider }),
        );
      window.addEventListener("groundhog:requestProvider", announce);
      announce();
    },
    {
      networkHash: scope.networkId,
      accounts: [
        {
          address: toBase58(account.address),
          publicKey: toBase58(signer.publicKey.ed25519),
          nonce: "0",
        },
      ],
    },
  );
  const page = await context.newPage();
  let firstConfigRequest = true;
  await context.route("**/api/config", (route) => {
    if (firstConfigRequest) {
      firstConfigRequest = false;
      return route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
    }
    return route.fulfill({ json: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("VITE_") && key !== "VITE_THRUPUT_RPC_URL")) });
  });
  await context.route("https://explorer.example.test/**", (route) =>
    route.fulfill({ body: "Explorer fixture" }),
  );
  const errors = [];
  const searches = [];
  let unavailable = false;
  let networkReads = 0;
  let checkingCreation = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/thruput-rpc", async (route) => {
    const request = route.request().postDataJSON();
    if (["getVersionInfo", "getServerLimits"].includes(request.method)) {
      await route.fulfill({ json: { jsonrpc: "2.0", id: request.id,
        result: await new MockTransport().request(request.method, request.params) } });
      return;
    }
    if (!checkingCreation && request.method === "simulateInvocation") {
      await route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "Directory is outside this UI fixture",
          },
        },
      });
      return;
    }
    assert.equal(
      request.method,
      "getNetworkInfo",
      "No contract reads or writes may follow a network mismatch",
    );
    networkReads += 1;
    await route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: request.id,
        result: { networkHash: checkingCreation ? id(0xff) : scope.networkId },
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
  await page.goto(url);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByRole("heading", { name: "Connect your wallet", exact: true })
    .waitFor();
  assert.equal(
    page.url(),
    url,
    "Launchpad handoff must survive a disconnected visit",
  );
  checkingCreation = true;
  await page.getByRole("button", { name: "Open navigation" }).click();
  assert.equal(await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Create Pool" }).getAttribute("href"), "/pools/new");
  await page.getByRole("button", { name: "Close navigation" }).click();
  networkReads = 0;
  await page
    .getByRole("button", {
      name: "Connect UI fixture (cannot sign)",
      exact: true,
    })
    .click();
  assert.equal(
    await page.getByRole("combobox", { name: "Wallet provider" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Disconnect" }).waitFor();
  const selectedLink = page.getByRole("link", {
    name: `Selected token address: ${a} (opens explorer in a new tab)`,
  });
  await selectedLink.waitFor();
  assert.equal(
    await selectedLink.getAttribute("href"),
    `https://explorer.example.test/address/${a}`,
  );
  assert.equal(await selectedLink.getAttribute("rel"), "noopener noreferrer");
  await selectedLink.focus();
  await page.getByRole("tooltip").waitFor();
  assert.equal(await page.getByRole("tooltip").textContent(), a);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Full tooltip must fit the mobile viewport",
  );
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
  assert.equal(
    await page
      .locator('[role="option"] a, [role="option"] button, button a')
      .count(),
    0,
  );
  const highlighted = page.getByRole("link", {
    name: `Highlighted token address: ${b} (opens explorer in a new tab)`,
  });
  await highlighted.waitFor();
  await highlighted.focus();
  const [explorerPage] = await Promise.all([
    context.waitForEvent("page"),
    highlighted.press("Enter"),
  ]);
  await explorerPage.waitForURL(`https://explorer.example.test/address/${b}`);
  assert.equal(
    await addresses.nth(1).inputValue(),
    "",
    "Opening explorer must not choose the highlighted token",
  );
  await explorerPage.close();
  await search.focus();
  assert.equal(searches[0], "");
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("option")
      .first()
      .getAttribute("aria-disabled"),
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
      document.activeElement?.getAttribute("aria-label") ===
      "Search tokens for Token B",
  );
  assert.equal(page.url(), url);
  await trigger.click();
  await search.press("Escape");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Search tokens for Token B",
  );

  unavailable = true;
  await trigger.click();
  await search.fill(id(0x0a));
  await page
    .getByText("Token discovery is unavailable. Try again or use an address.")
    .waitFor();
  await page
    .getByRole("option", { name: `Use address ${id(0x0a)}`, exact: true })
    .tap();
  assert.equal(await addresses.nth(1).inputValue(), id(0x0a));
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
  await page.keyboard.press("Escape");
  await checkBrand(page);
  const launchpad = await createServer({
    mode: "browser-test",
    root: fileURLToPath(new URL("../../apps/token-launchpad", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await launchpad.listen();
    const launchOrigin = `http://127.0.0.1:${launchpad.httpServer.address().port}`;
    const launch = await context.newPage();
    await launch.route("**/thruput-rpc", async (route) => {
      const body = route.request().postDataJSON();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: body.method === "getNetworkInfo" ? { networkHash: scope.networkId } : await new MockTransport().request(body.method, body.params),
        }),
      });
    });
    await launch.route("**/api/tokens?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          tokens: [],
          total: 0,
          limit: 20,
          offset: 0,
          asOfBlock: "1",
          hasMore: false,
          historyLimited: false,
        }),
      }),
    );
    const registryStatus = {
      networkId: scope.networkId,
      factoryAddress: scope.factoryAddress,
      indexedThroughBlock: "1",
      tokenCount: 0,
      historyLimited: false,
      syncState: "idle",
      syncing: false,
      lastSuccessfulSyncAt: null,
      lastError: null,
    };
    await launch.route("**/api/registry/*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(registryStatus),
      }),
    );
    await launch.goto(`${launchOrigin}/tokens`);
    await launch.getByText("No tokens yet", { exact: true }).waitFor();
    await launch
      .getByRole("button", {
        name: "Connect UI fixture (cannot sign)",
        exact: true,
      })
      .click();
    await launch
      .getByRole("button", { name: "Disconnect", exact: true })
      .waitFor();
    await launch.goto(`${launchOrigin}/create`);
    await launch
      .getByRole("button", {
        name: "Connect UI fixture (cannot sign)",
        exact: true,
      })
      .click();
    await launch
      .getByRole("button", { name: "Review launch", exact: true })
      .waitFor();
    for (const width of [320, 1280]) {
      await launch.setViewportSize({ width, height: 900 });
      assert.equal(await launch.getByRole("banner").count(), 1);
      assert.equal(
        await launch.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    await checkBrand(launch);
    await launch.close();
  } finally {
    await launchpad.close();
  }
  console.log(
    `PASS: Chromium ${browser.version()}; both apps, 320px/desktop layout, wallet controls, registry directory, token search, manual fallback and preset guards. No signing.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
