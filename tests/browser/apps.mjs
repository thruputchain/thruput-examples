import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { Ed25519Signer, toBase58, MockTransport } from "@thruputchain/client";
import { createPubkeyAccount } from "@thruputchain/client/wallet";
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
} from "@thruputchain/client/provider";

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
  VITE_NATIVE_TOKEN_ADDRESS: id(0x05),
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: scope.factoryAddress,
  VITE_STANDARD_TOKEN_HASH: scope.tokenCodeHash,
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
  const signer = new Ed25519Signer(new Uint8Array(32).fill(9));
  const account = createPubkeyAccount({ signer });
  await context.addInitScript(
    ({ session, announceEvent, requestEvent }) => {
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
          new CustomEvent(announceEvent, { detail: provider }),
        );
      window.addEventListener(requestEvent, announce);
      announce();
    },
    {
      announceEvent: ANNOUNCE_PROVIDER_EVENT,
      requestEvent: REQUEST_PROVIDER_EVENT,
      session: {
        networkHash: scope.networkId,
        accounts: [
          {
            address: toBase58(account.address),
            publicKey: toBase58(signer.publicKey.ed25519),
            nonce: "0",
          },
        ],
      },
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/thruput-rpc", async (route) => {
    const request = route.request().postDataJSON();
    if (["getVersionInfo", "getServerLimits"].includes(request.method)) {
      await route.fulfill({ json: { jsonrpc: "2.0", id: request.id,
        result: await new MockTransport().request(request.method, request.params) } });
      return;
    }
    assert.equal(request.method, "getNetworkInfo", "The create page reads nothing before review");
    await route.fulfill({
      json: { jsonrpc: "2.0", id: request.id, result: { networkHash: scope.networkId } },
    });
  });
  // Swap searches the Launchpad app's token API on the same origin.
  await page.route("**/launchpad/api/tokens*", async (route) => {
    searches.push(new URL(route.request().url()).searchParams.get("q") || "");
    await route.fulfill(
      unavailable
        ? { status: 502, json: { error: "Unavailable" } }
        : {
            json: {
              tokens: [a, b].map((address, index) => ({
                address,
                creator: a,
                name: `Token ${index}`,
                symbol: `T${index}`,
                decimals: 6,
                initialSupply: "1",
                blockHeight: "1",
                transactionHash: a,
              })),
              hasMore: false,
              indexedThrough: "1",
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
  assert.equal(page.url(), url, "Launchpad handoff must survive a disconnected visit");
  await page.getByRole("button", { name: "Open navigation" }).click();
  assert.equal(await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Create Pool" }).getAttribute("href"), "/pools/new");
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect" }).waitFor();
  const tokenA = page.getByLabel("Token A address", { exact: true });
  const tokenB = page.getByLabel("Token B address", { exact: true });
  await tokenA.waitFor();
  assert.equal(await tokenA.inputValue(), a);
  assert.equal(await tokenB.inputValue(), "");

  const trigger = page.getByRole("button", { name: "Search tokens for Token B", exact: true });
  await trigger.tap();
  const search = page.getByRole("combobox", { name: "Search tokens for Token B", exact: true });
  await search.waitFor();
  await page.getByText("2 Launchpad tokens.", { exact: true }).waitFor();
  assert.equal(searches[0], "");
  await search.fill("T1");
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 2);
  assert.ok(searches.includes("T1"));
  const bounds = await page.getByRole("dialog").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320, "Popover must fit the mobile viewport");
  await page.getByRole("option").nth(1).tap();
  assert.equal(await tokenB.inputValue(), b);
  assert.equal(page.url(), url);

  unavailable = true;
  await trigger.click();
  await search.fill("missing");
  await page.getByText("Token search is unavailable. Paste an address instead.").waitFor();
  await page.keyboard.press("Escape");
  await tokenB.fill(id(0x0a));
  assert.equal(await tokenB.inputValue(), id(0x0a));
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "320px page must not overflow",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(errors, []);
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
        body: JSON.stringify({ tokens: [], hasMore: false, indexedThrough: "1" }),
      }),
    );
    await launch.goto(`${launchOrigin}/tokens`);
    await launch.getByText("No tokens yet", { exact: true }).waitFor();
    await launch
      .getByRole("button", {
        name: "Connect wallet",
        exact: true,
      })
      .click();
    await launch
      .getByRole("button", { name: "Disconnect", exact: true })
      .waitFor();
    await launch.goto(`${launchOrigin}/create`);
    await launch
      .getByRole("button", {
        name: "Connect wallet",
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
    `PASS: Chromium ${browser.version()}; both apps, 320px/desktop layout, wallet controls, token directory, Launchpad token search, manual fallback and the Launchpad handoff. No signing.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
