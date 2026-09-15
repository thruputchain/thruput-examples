import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import {
  createGroundhogClient,
  HttpTransport,
  hashFromHex,
} from "@groundhogchain/client";
import { ExecResult } from "@groundhogchain/protocol";

// This test spends only newly airdropped localnet HOG, sending one base unit
// back to the fresh test account. It does not access an existing browser profile.
// --connect-only mocks RPC identity/balance and needs no node or funds.
const connectOnly = process.argv.includes("--connect-only");
const screenshotDir = process.env.WALLET_SCREENSHOT_DIR;
if (screenshotDir && !connectOnly)
  throw new Error("Screenshots require isolated --connect-only mode");
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
async function capture(page, name) {
  if (!screenshotDir) return;
  const viewport = page.viewportSize();
  for (const width of [400, 800]) {
    await page.setViewportSize({ width, height: 680 });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.title(), "Thruput Wallet");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${name}: overflow at ${width}px`,
    );
    // Never capture a recovery backup or a populated password/phrase field.
    assert.equal(await page.locator(".seed").count(), 0);
    for (const input of await page
      .locator('input[type="password"], textarea[name="mnemonic"]')
      .all())
      assert.equal(await input.inputValue(), "");
    await page.screenshot({
      path: join(screenshotDir, `${name}-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize(viewport);
}
const client = await createGroundhogClient({
  transport: new HttpTransport("http://127.0.0.1:9545"),
});
if (!connectOnly) {
  const network = await client.getNetworkInfo();
  assert(
    network.networkHash.every((byte) => byte === 0),
    "Expected localnet identity",
  );
}
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
  import {createGroundhogClient, HttpTransport, createProviderWalletClient} from '@groundhogchain/client';
  import {discoverWalletProviders} from '@groundhogchain/client/provider';
  import {ERC20} from '@groundhogchain/client/contracts';
  import {contractAddress, gasAmount, blockHeight} from '@groundhogchain/protocol';
  window.providerEvents = [];
  discoverWalletProviders(provider => {
    window.provider = provider;
    provider.on('change', () => window.providerEvents.push('change'));
  });
  window.connect = async () => {
    const client = await createGroundhogClient({transport:new HttpTransport('http://127.0.0.1:9545')});
    window.session = await window.provider.request({method:'connect'});
    window.providerEvents.push('connect resolved');
    window.adapter = createProviderWalletClient({provider:window.provider, account:window.session.accounts[0], networkHash:window.session.networkHash, client});
    if (window.prepareImmediately) {
      const receiver = contractAddress(Uint8Array.from(window.session.accounts[0].address.slice(2).match(/../g), b => parseInt(b,16)));
      await window.adapter.prepareExecution({gasLimit:gasAmount(1000000n),blockExpiryHeight:blockHeight(100n),invocation:ERC20.transfer.invocation(receiver,gasAmount(500000n),{receiver,amount:1n})});
      window.providerEvents.push('prepared');
    }
    return window.session;
  };
  window.sign = async height => {
    const account = window.session.accounts[0];
    const receiver = contractAddress(Uint8Array.from(account.address.slice(2).match(/../g), b => parseInt(b,16)));
    const hog = contractAddress(Uint8Array.from([...new Uint8Array(31),1]));
    const tx = await window.adapter.prepareExecution({gasLimit:gasAmount(1000000n), blockExpiryHeight:blockHeight(BigInt(height)+100n), invocation:ERC20.transfer.invocation(hog,gasAmount(500000n),{receiver,amount:1n})});
    const signed = await window.adapter.signTransaction(tx);
    localStorage.setItem('signed-transfer', JSON.stringify(signed));
    return signed;
  };
  window.submit = () => window.adapter.submitTransaction(JSON.parse(localStorage.getItem('signed-transfer')));
`,
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
});
let identityChecks = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
  if (connectOnly && url.origin === "http://127.0.0.1:9545") {
    // Proxy interception covers service-worker fetches as well as page fetches.
    // Never forward to an existing node, and never log request bodies.
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) throw new Error("Request too large");
      }
      const rpc = JSON.parse(body);
      const identity = rpc.method === "groundhog_networkInfo";
      const balance = rpc.method === "groundhog_getBalance";
      if (identity) identityChecks++;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          ...(identity || balance
            ? {
                result: identity
                  ? { networkHash: `0x${"00".repeat(32)}` }
                  : {
                      address: rpc.params[0],
                      rawBalance: "1234567890",
                      height: 1,
                    },
              }
            : {
                error: {
                  code: -32601,
                  message: "Connect-only RPC: method disabled",
                },
              }),
        }),
      );
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  if (url.origin !== `http://127.0.0.1:${server.address().port}`) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader(
    "Content-Type",
    url.pathname === "/sdk.js" ? "text/javascript" : "text/html",
  );
  res.end(
    url.pathname === "/sdk.js"
      ? bundle.outputFiles[0].contents
      : '<!doctype html><title>SDK wallet acceptance</title><h1>SDK wallet acceptance</h1><script type="module" src="/sdk.js"></script>',
  );
});
server.on("connect", (_req, socket) => socket.destroy());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "groundhog-wallet-acceptance-"));
let context;
try {
  const extensionPath = resolve("dist");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
      ...(connectOnly ? ["--proxy-bypass-list=<-loopback>"] : []),
    ],
    ...(connectOnly
      ? { proxy: { server: `http://127.0.0.1:${server.address().port}` } }
      : {}),
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  let ui = await context.newPage();
  await ui.setViewportSize({ width: 400, height: 680 });
  const uiUrl = `chrome-extension://${id}/index.html`;
  await ui.goto(uiUrl);
  await ui.getByRole("button", { name: "Create encrypted wallet" }).waitFor();
  assert.equal(await ui.title(), "Thruput Wallet");
  await ui.getByRole("link", { name: "Thruput Wallet home" }).waitFor();
  await ui.evaluate(() => document.fonts.ready);
  assert.deepEqual(
    await ui.evaluate(() => {
      const body = getComputedStyle(document.body);
      const heading = getComputedStyle(document.querySelector("h1"));
      return [body.fontFamily, body.fontSize, heading.fontFamily];
    }),
    ['"IBM Plex Sans", sans-serif', "14px", '"IBM Plex Mono", monospace'],
  );
  const contrast = await ui.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = (token) => {
      const hex = style.getPropertyValue(token).trim().slice(1);
      const [r, g, b] = hex.match(/../g).map((byte) => {
        const value = parseInt(byte, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return [
      ["--foreground", "--background"],
      ["--muted-foreground", "--card"],
      ["--muted-foreground", "--secondary"],
      ["--primary-foreground", "--primary"],
      ["--destructive", "--card"],
      ["--success", "--card"],
      ["--warning", "--card"],
    ].map(([foreground, background]) => {
      const a = luminance(foreground);
      const b = luminance(background);
      return {
        foreground,
        background,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
  });
  for (const pair of contrast)
    assert.ok(
      pair.ratio >= 4.5,
      `Insufficient text contrast: ${JSON.stringify(pair)}`,
    );
  const manifest = await ui.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, "Thruput Wallet");
  assert.equal(manifest.action.default_title, "Thruput Wallet");
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.action.default_icon[size], manifest.icons[size]);
    assert.deepEqual(
      await ui.evaluate(async (path) => {
        const image = new Image();
        image.src = path;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }, manifest.icons[size]),
      [size, size],
    );
  }
  await capture(ui, "onboarding");
  await ui.getByRole("button", { name: "Restore wallet", exact: true }).click();
  await ui.getByLabel("Recovery phrase").waitFor();
  await capture(ui, "restore");
  await ui.getByRole("button", { name: "Create wallet", exact: true }).click();
  await ui
    .getByLabel("Password (at least 12 characters)")
    .fill("browser acceptance password");
  await ui.getByLabel("Confirm password").fill("browser acceptance password");
  await ui.getByRole("button", { name: "Create encrypted wallet" }).click();
  await ui.getByRole("heading", { name: "Wallet settings" }).waitFor();
  if (connectOnly) {
    await capture(ui, "settings-notice");
    await ui.getByRole("button", { name: "Assets", exact: true }).click();
    await ui.locator(".balance").filter({ hasText: "123.456789" }).waitFor();
    // Reopening the popup clears the transient onboarding notice.
    await ui.reload();
    await ui.locator(".balance").filter({ hasText: "123.456789" }).waitFor();
    await capture(ui, "portfolio");
    const checksBeforeReconnect = identityChecks;
    await ui.getByRole("button", { name: "Reconnect", exact: true }).click();
    await ui.getByText("Network reconnected. Reconnect your apps.", { exact: true }).waitFor();
    assert(identityChecks > checksBeforeReconnect, "Reconnect must recheck the selected network");
    assert.equal(await ui.getByLabel("Network", { exact: true }).inputValue(), "localnet");
    await capture(ui, "network-reconnected");
    await ui.getByRole("button", { name: "Send", exact: true }).click();
    await capture(ui, "send");
  }
  if (!connectOnly) {
    await ui.getByRole("button", { name: "Assets", exact: true }).click();
    await ui.getByRole("button", { name: "Request test HOG" }).click();
    await ui.getByText(/^Airdrop confirmed:/).waitFor({ timeout: 60000 });
  }
  await ui.getByRole("button", { name: "Lock", exact: true }).click();
  await ui.getByRole("button", { name: "Unlock wallet" }).waitFor();
  await capture(ui, "unlock");
  await ui.getByLabel("Password", { exact: true }).focus();
  await ui.keyboard.press("Tab");
  assert.equal(
    await ui.getByRole("button", { name: "Unlock wallet" }).evaluate(
      (el) =>
        el === document.activeElement &&
        getComputedStyle(el).outlineStyle === "solid",
    ),
    true,
  );
  await capture(ui, "unlock-keyboard-focus");
  const dapp = await context.newPage();
  await dapp.goto(`http://127.0.0.1:${server.address().port}`);
  await dapp.waitForFunction(() => Boolean(window.provider));
  assert.deepEqual(await dapp.evaluate(() => window.provider.info), {
    id: "dev.groundhog.wallet",
    name: "Thruput Wallet",
    version: "1.0.0",
  });
  let popupEvent = context.waitForEvent("page");
  if (connectOnly) await dapp.evaluate(() => { window.prepareImmediately = true; });
  const connection = dapp.evaluate(() => window.connect());
  let popup = await popupEvent;
  await popup.getByRole("button", { name: "Unlock wallet" }).waitFor();
  await capture(popup, "approval-locked");
  assert.equal(
    await popup.getByRole("button", { name: "Connect", exact: true }).count(),
    0,
  );
  await popup.getByLabel("Password", { exact: true }).fill("wrong password");
  await popup.getByRole("button", { name: "Unlock wallet" }).click();
  await popup.getByRole("alert").waitFor();
  await capture(popup, "unlock-error");
  assert.deepEqual(
    await dapp.evaluate(
      async () =>
        (await window.provider.request({ method: "getSession" })).accounts,
    ),
    [],
  );
  await popup
    .getByLabel("Password", { exact: true })
    .fill("browser acceptance password");
  await popup.getByRole("button", { name: "Unlock wallet" }).click();
  await popup.getByRole("checkbox").first().waitFor();
  await capture(popup, "approval");
  await popup.getByRole("checkbox").first().uncheck();
  assert.equal(
    await popup.getByRole("button", { name: "Connect", exact: true }).isDisabled(),
    true,
  );
  await capture(popup, "approval-disabled");
  await popup.getByRole("checkbox").first().check();
  assert.deepEqual(
    await dapp.evaluate(
      async () =>
        (await window.provider.request({ method: "getSession" })).accounts,
    ),
    [],
  );
  assert.equal(await dapp.evaluate(() => window.session), undefined);
  assert.deepEqual(
    await ui.evaluate(
      async () => (await chrome.storage.local.get("wallet")).wallet.grants,
    ),
    undefined,
  );
  await popup.getByRole("button", { name: "Connect", exact: true }).click();
  const session = await connection;
  assert.equal(session.accounts.length, 1);
  assert.equal(session.networkHash, "00".repeat(32));
  if (connectOnly) {
    assert.deepEqual(await dapp.evaluate(() => window.providerEvents), [
      "change", "connect resolved", "prepared",
    ]);
    await ui.reload();
    await ui.locator(".balance").filter({ hasText: "123.456789" }).waitFor();
    // Record clipboard writes without depending on headless OS clipboard access.
    await ui.evaluate(() => {
      window.clipboardWrites = [];
      navigator.clipboard.writeText = async (text) => {
        window.clipboardWrites.push(text);
      };
    });
    const address = ui.locator(".address");
    assert.equal(await address.textContent(), session.accounts[0].address);
    assert.equal(await address.evaluate((el) => el.tagName), "P");
    await address.click();
    assert.deepEqual(await ui.evaluate(() => window.clipboardWrites), []);
    assert.equal(await ui.locator(".notice").count(), 0);
    assert.equal(await address.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    }), session.accounts[0].address);
    await ui.getByRole("button", { name: "Copy address", exact: true }).click();
    await ui.getByRole("status").filter({ hasText: "Address copied." }).waitFor();
    assert.deepEqual(await ui.evaluate(() => window.clipboardWrites), [session.accounts[0].address]);
    await ui.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error("Clipboard unavailable"); };
    });
    await ui.getByRole("button", { name: "Copy address", exact: true }).click();
    await ui.getByRole("alert").filter({ hasText: "Clipboard unavailable" }).waitFor();
    assert.equal(await ui.locator(".notice").count(), 0);

    await ui.getByRole("button", { name: "Settings", exact: true }).click();
    const originalAccount = await ui.locator("#account").inputValue();
    await ui.getByRole("button", { name: "Add derived account", exact: true }).click();
    await ui.getByRole("status").filter({ hasText: "Account added." }).waitFor();
    const options = await ui.locator("#account option").evaluateAll(
      (elements) => elements.map((el) => ({ value: el.value, name: el.textContent })),
    );
    assert.equal(options.length, 2);
    assert.equal(await ui.locator("#account").inputValue(), originalAccount);
    assert.equal(await ui.getByRole("alert").count(), 0);
    await capture(ui, "settings-account-added");
    // Fail only this page's next add-account RPC; never alter worker or vault.
    await ui.evaluate(() => {
      const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message) => {
        if (message.kind === "ui" && message.op === "addAccount") {
          chrome.runtime.sendMessage = sendMessage;
          return { error: { message: "Account creation unavailable" } };
        }
        return sendMessage(message);
      };
    });
    await ui.getByRole("button", { name: "Add derived account", exact: true }).click();
    await ui.getByRole("alert").filter({ hasText: "Account creation unavailable" }).waitFor();
    assert.equal(await ui.locator(".notice").count(), 0);
    assert.equal(await ui.locator("#account option").count(), 2);
    await capture(ui, "settings-account-error");
    await ui.reload();
    await ui.locator("#account option").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await ui.locator("#account option").evaluateAll(
      (elements) => elements.map((el) => ({ value: el.value, name: el.textContent })),
    ), options);
    await ui.locator("#account").selectOption(options[1].value);
    assert.equal(await ui.locator(".address").textContent(), options[1].value);
    if (screenshotDir) {
      const { captureReviewStates } = await import("./visual-states.mjs");
      await captureReviewStates(context, uiUrl, capture);
    }
    assert.ok(
      identityChecks >= 2,
      "Extension preflight and approval must check RPC identity",
    );
    assert.deepEqual(
      await dapp.evaluate(() =>
        window.provider.request({ method: "getSession" }),
      ),
      session,
    );
    const { checkWorkerRaces, checkUiRaces } = await import("./browser-races.mjs");
    await checkWorkerRaces({ context, worker, ui, uiUrl, dapp });
    await checkUiRaces(context, uiUrl);
    console.log(
      JSON.stringify({
        sdkFlow: "lock -> connect -> wrong password -> unlock -> approve",
        rpc: "mocked identity through isolated browser proxy",
        funds: "none",
        provider: "Thruput Wallet (dev.groundhog.wallet)",
        account: "derived account success, RPC failure, and dropdown persistence verified",
        copy: "selectable address, separate copy action, success and failure verified",
        races: "preflight cancellation, failed grant cleanup, restart, scoped portfolio and preparation verified",
        ordering: "change before connect/disconnect resolution; immediate SDK preparation succeeds",
        screenshots: screenshotDir || "disabled",
      }),
    );
  } else {
    const height = (await client.getChainTip()).height.toString();
    popupEvent = context.waitForEvent("page");
    const signing = dapp.evaluate((height) => window.sign(height), height);
    popup = await popupEvent;
    await popup.getByText("Not simulated", { exact: true }).waitFor();
    await popup.getByRole("button", { name: "Sign only" }).click();
    const signed = await signing;
    const persisted = await ui.evaluate(
      async () => (await chrome.storage.local.get("wallet")).wallet.approvals,
    );
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].signedTransaction, signed.signedTransaction);
    assert.equal(
      await client.getTransactionReceipt(hashFromHex(signed.hash)),
      null,
      "Signing must not broadcast",
    );
    const submitted = await dapp.evaluate(() => window.submit());
    assert.equal(submitted.hash, signed.hash);
    const receipt = await client.waitForTransactionReceipt(
      hashFromHex(signed.hash),
      { timeoutMs: 60000 },
    );
    assert.equal(receipt.execResult, ExecResult.ExecResultOK);
    assert.equal(
      await ui.evaluate(
        async () =>
          (await chrome.storage.local.get("wallet")).wallet.approvals.length,
      ),
      0,
    );
    assert.equal(
      await dapp.evaluate(async () => {
        try {
          await window.submit();
          return 0;
        } catch (error) {
          return error.code;
        }
      }),
      4100,
    );

    // Close the wallet immediately after crossing its broadcast boundary. The
    // independent hash record, not signed bytes or popup state, must recover it.
    const transfer = await ui.evaluate(async (account) => {
      const reply = await chrome.runtime.sendMessage({
        kind: "ui",
        op: "prepareTransfer",
        account,
        token: `0x${"0".repeat(63)}1`,
        receiver: account,
        amount: "0.0000001",
      });
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    }, session.accounts[0].address);
    await ui.evaluate(
      ({ transfer, account }) => {
        void chrome.runtime.sendMessage({
          kind: "ui",
          op: "sendTransfer",
          account,
          networkHash: transfer.networkHash,
          transaction: transfer.transaction,
        });
      },
      { transfer, account: session.accounts[0].address },
    );
    await ui.waitForFunction(
      async () =>
        (await chrome.storage.local.get("wallet")).wallet.outgoing.length === 1,
    );
    await ui.close();
    ui = await context.newPage();
    await ui.goto(uiUrl);
    await ui.getByRole("region", { name: "Outgoing transfers" }).waitFor();
    await ui.getByRole("button", { name: "Check status" }).click();
    assert.equal(
      await ui.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    console.log(
      JSON.stringify({
        extensionId: id,
        sdkFlow:
          "lock -> connect -> wrong password -> unlock -> approve -> prepare -> sign -> persist -> submit -> receipt",
        hash: signed.hash,
        recovery: "visible after popup closure",
        duplicateSubmit: "rejected with 4100",
      }),
    );
  }
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
