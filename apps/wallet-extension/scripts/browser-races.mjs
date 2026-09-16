import assert from "node:assert/strict";

// Called only by isolated --connect-only acceptance. All network traffic stays
// behind its deny-by-default proxy; UI fixtures below never call the worker.
export async function checkWorkerRaces({ context, worker, ui, uiUrl, dapp }) {
  await checkAirdropRefresh(worker, ui, uiUrl);
  await dapp.evaluate(async () => {
    window.providerEvents = [];
    await window.provider.request({ method: "disconnect" });
    window.providerEvents.push("disconnect resolved");
  });
  assert.deepEqual(await dapp.evaluate(() => window.providerEvents), [
    "change",
    "disconnect resolved",
  ]);

  await worker.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const rpc = JSON.parse(args[1]?.body || "{}");
      if (rpc.method !== "groundhog_networkInfo") return original(...args);
      globalThis.fetch = original;
      await new Promise((resolve) => {
        globalThis.releaseIdentity = resolve;
      });
      const response = await original(...args);
      globalThis.identityReleased = true;
      return response;
    };
  });
  await dapp.evaluate(() => {
    window.canceledId = crypto.randomUUID();
    const listener = (event) => {
      if (
        event.data?.channel === "groundhog:extension:reply" &&
        event.data.id === window.canceledId
      ) {
        window.canceledResult = event.data;
        window.removeEventListener("message", listener);
      }
    };
    window.addEventListener("message", listener);
    window.postMessage(
      {
        channel: "groundhog:extension:request",
        id: window.canceledId,
        request: { method: "connect" },
      },
      location.origin,
    );
  });
  await poll(() => worker.evaluate(() => Boolean(globalThis.releaseIdentity)));
  await dapp.evaluate(() =>
    window.postMessage(
      {
        channel: "groundhog:extension:request",
        id: window.canceledId,
        cancel: true,
      },
      location.origin,
    ),
  );
  await dapp.waitForFunction(() => window.canceledResult?.error?.code === 4001);
  await worker.evaluate(() => globalThis.releaseIdentity());
  await poll(() => worker.evaluate(() => globalThis.identityReleased));

  // A fresh connection proves the canceled preflight released its origin slot.
  const popupEvent = context.waitForEvent("page");
  await dapp.evaluate(() => {
    window.failedConnection = window.provider
      .request({ method: "connect" })
      .then(
        (result) => ({ result }),
        (error) => ({ code: error.code }),
      );
  });
  const popup = await popupEvent;
  await popup.getByRole("button", { name: "Connect", exact: true }).waitFor();
  assert.equal(
    context.pages().filter((page) => page.url().includes("?approval=")).length,
    1,
  );
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    let writes = 0;
    chrome.storage.local.set = async (value) => {
      writes++;
      if (writes === 1)
        await new Promise((resolve) => {
          globalThis.releaseGrantWrite = resolve;
        });
      else if (writes === 2) {
        chrome.storage.local.set = original;
        globalThis.cleanupFailed = true;
        throw new Error("Injected cleanup failure");
      }
      return original(value);
    };
  });
  await popup.getByRole("button", { name: "Connect", exact: true }).click();
  await poll(() =>
    worker.evaluate(() => Boolean(globalThis.releaseGrantWrite)),
  );
  assert.equal(await accountCount(dapp), 0);
  await popup.close();
  assert.equal((await dapp.evaluate(() => window.failedConnection)).code, 4001);
  assert.equal(await accountCount(dapp), 0);
  await worker.evaluate(() => globalThis.releaseGrantWrite());
  await poll(() => worker.evaluate(() => globalThis.cleanupFailed));
  assert.equal(await accountCount(dapp), 0);
  assert.equal(
    await ui.evaluate(async () =>
      Object.hasOwn(
        (await chrome.storage.local.get("wallet")).wallet,
        "grants",
      ),
    ),
    false,
  );

  // Stop this disposable worker through CDP, then wake and unlock it. No vault
  // contents are inspected; only the public authorization result is checked.
  const cdp = await context.newCDPSession(ui);
  let versions = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (event) => {
    versions = event.versions;
  });
  await cdp.send("ServiceWorker.enable");
  await poll(() =>
    versions.some(
      (version) =>
        version.scriptURL === worker.url() &&
        version.runningStatus === "running",
    ),
  );
  const version = versions.find(
    (version) =>
      version.scriptURL === worker.url() && version.runningStatus === "running",
  );
  await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  // Corrupt only peripheral fields in this disposable profile while the worker
  // is stopped. The envelope is carried through unchanged, never displayed.
  await ui.evaluate(async () => {
    const { wallet } = await chrome.storage.local.get("wallet");
    await chrome.storage.local.set({
      wallet: { ...wallet, pin: "invalid", recoveryBlocked: true },
    });
  });
  await ui.goto(uiUrl);
  await ui.getByRole("button", { name: "Unlock wallet" }).waitFor();
  await ui
    .getByLabel("Password", { exact: true })
    .fill("browser acceptance password");
  await ui.getByRole("button", { name: "Unlock wallet" }).click();
  await ui.getByRole("heading", { name: "Your assets" }).waitFor();
  assert.equal(await accountCount(dapp), 0);
  assert.equal(
    await ui.getByLabel("Network", { exact: true }).inputValue(),
    "",
  );
  await ui
    .getByRole("status")
    .filter({ hasText: "Transfer recovery data is damaged" })
    .waitFor();
  // Selecting the previously configured localnet must fire onChange. The real
  // worker pins through the isolated local RPC proxy; no direct UI RPC call.
  await ui.getByLabel("Network", { exact: true }).selectOption("localnet");
  await poll(() =>
    ui.evaluate(async () => {
      const { wallet } = await chrome.storage.local.get("wallet");
      return wallet.network === "localnet" && wallet.pin === "00".repeat(32);
    }),
  );
  // Persisting the pin precedes the asynchronous UI state refresh.
  await poll(async () =>
    (await ui.getByLabel("Network", { exact: true }).inputValue()) === "localnet",
  );
  // Verify the README's script-free repair context can save an encrypted backup
  // without displaying its contents. This profile contains only test accounts.
  const repair = await context.newPage();
  await repair.goto(new URL("favicon.svg", uiUrl).href);
  const downloadEvent = repair.waitForEvent("download");
  await repair.evaluate(async () => {
    const backup = await chrome.storage.local.get(null);
    const blob = new Blob([JSON.stringify(backup)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
    link.href = url;
    link.download = "thruput-encrypted-storage-backup.json";
    document.documentElement.append(link);
    link.click();
    link.remove();
  });
  const download = await downloadEvent;
  assert.equal(
    download.suggestedFilename(),
    "thruput-encrypted-storage-backup.json",
  );
  assert.equal(await download.failure(), null);
  await download.delete();
  await repair.close();
  await cdp.detach();
}

async function checkAirdropRefresh(worker, ui, uiUrl) {
  const accounts = await ui
    .locator("#account option")
    .evaluateAll((options) => options.map((option) => option.value));
  assert.equal(accounts.length, 2);
  await worker.evaluate((first) => {
    const original = globalThis.fetch;
    globalThis.restoreReviewFetch = () => {
      globalThis.fetch = original;
    };
    globalThis.balanceOwners = [];
    globalThis.fetch = async (...args) => {
      const rpc = JSON.parse(args[1]?.body || "{}");
      let result;
      if (rpc.method === "groundhog_getBalance") {
        globalThis.balanceOwners.push(rpc.params[0]);
        result = {
          address: rpc.params[0],
          rawBalance: rpc.params[0] === first ? "1110000000" : "2220000000",
          height: 1,
        };
      } else if (rpc.method === "groundhog_requestAirdrop") {
        await new Promise((resolve) => {
          globalThis.finishAirdrop = resolve;
        });
        result = {
          attemptStatus: "succeeded",
          recipient: rpc.params[0].recipient,
          rawAmount: "1",
          txHash: `0x${"33".repeat(32)}`,
          height: 1,
          status: { result: "ok" },
        };
      } else return original(...args);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
  }, accounts[0]);
  try {
    await ui.goto(uiUrl);
    await ui.locator(".balance").filter({ hasText: "111" }).waitFor();
    await ui
      .getByRole("button", { name: "Request test HOG", exact: true })
      .click();
    await poll(() => worker.evaluate(() => Boolean(globalThis.finishAirdrop)));
    await ui.locator("#account").selectOption(accounts[1]);
    // The new account's portfolio request queues behind the in-flight airdrop.
    await ui
      .getByRole("status")
      .filter({ hasText: "Reading balances" })
      .waitFor();
    await worker.evaluate(() => globalThis.finishAirdrop());
    await ui
      .getByRole("status")
      .filter({ hasText: "Airdrop confirmed:" })
      .waitFor();
    await poll(() =>
      worker.evaluate(() => globalThis.balanceOwners.length >= 3),
    );
    await ui.locator(".balance").filter({ hasText: "222" }).waitFor();
    assert.deepEqual(await worker.evaluate(() => globalThis.balanceOwners), [
      accounts[0],
      accounts[1],
      accounts[1],
    ]);
    assert.equal(await ui.locator("#account").inputValue(), accounts[1]);
  } finally {
    await worker.evaluate(() => globalThis.restoreReviewFetch());
  }
}

async function accountCount(dapp) {
  return dapp.evaluate(
    async () =>
      (await window.provider.request({ method: "getSession" })).accounts.length,
  );
}

async function poll(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Browser race checkpoint timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function checkUiRaces(context, uiUrl) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const a = `0x${"11".repeat(32)}`,
      b = `0x${"22".repeat(32)}`;
    const state = {
      exists: true,
      unlocked: true,
      network: "localnet",
      networkHash: "00".repeat(32),
      expires: Date.now() + 600000,
      accounts: [
        { address: a, name: "A", index: 0 },
        { address: b, name: "B", index: 1 },
      ],
      sites: [],
      outgoing: [],
    };
    const listeners = [];
    chrome.runtime.onMessage.addListener = (listener) =>
      listeners.push(listener);
    chrome.runtime.onMessage.removeListener = (listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
    window.changeState = (patch) => {
      Object.assign(state, patch);
      for (const listener of listeners) listener({ kind: "stateChanged" });
    };
    window.portfolioOwners = [];
    window.preparations = [];
    chrome.runtime.sendMessage = async ({ op, account }) => {
      if (op === "state") return { result: structuredClone(state) };
      if (op === "portfolio") {
        window.portfolioOwners.push(account);
        if (window.delayPortfolio) {
          window.delayPortfolio = false;
          await new Promise((resolve, reject) => {
            window.finishPortfolio = resolve;
            window.failPortfolio = reject;
          });
        }
        return {
          result: [
            {
              address: `0x${"0".repeat(63)}1`,
              symbol: "HOG",
              decimals: 0,
              balance: account === a ? "111" : "222",
            },
          ],
        };
      }
      if (op === "airdrop") {
        await new Promise((resolve) => {
          window.finishAirdrop = resolve;
        });
        return { result: { hash: `0x${"33".repeat(32)}` } };
      }
      if (op === "prepareTransfer") {
        const index = window.preparations.length;
        const networkHash = state.networkHash;
        await new Promise((resolve, reject) =>
          window.preparations.push({ resolve, reject }),
        );
        return {
          result: {
            transaction: "0x00",
            networkHash,
            review: {
              method: "execute",
              root: account,
              entrypoint: "0x00",
              gas: "1",
              expiry: "100",
              nonce: String(index),
              calldata: "0x00",
              deployments: [],
              calls: [],
            },
          },
        };
      }
      if (op === "lock") {
        window.changeState({ unlocked: false });
        return { result: structuredClone(state) };
      }
      throw new Error(`UI fixture forbids ${op}`);
    };
  });
  try {
    await page.goto(uiUrl);
    await page.locator(".balance").filter({ hasText: "111" }).waitFor();
    await page
      .getByRole("button", { name: "Request test HOG", exact: true })
      .click();
    await page.waitForFunction(() => Boolean(window.finishAirdrop));
    await page.locator("#account").selectOption(`0x${"22".repeat(32)}`);
    await page.locator(".balance").filter({ hasText: "222" }).waitFor();
    await page.evaluate(() => window.finishAirdrop());
    await page
      .getByRole("status")
      .filter({ hasText: "Airdrop confirmed:" })
      .waitFor();
    await page.waitForFunction(() => window.portfolioOwners.length === 3);
    assert.deepEqual(await page.evaluate(() => window.portfolioOwners), [
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      `0x${"22".repeat(32)}`,
    ]);
    await page.locator(".balance").filter({ hasText: "222" }).waitFor();

    // An old account's failed refresh cannot replace the new account's state.
    await page.evaluate(() => {
      window.delayPortfolio = true;
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.failPortfolio));
    await page.locator("#account").selectOption(`0x${"11".repeat(32)}`);
    await page.locator(".balance").filter({ hasText: "111" }).waitFor();
    await page.evaluate(() =>
      window.failPortfolio(new Error("Stale portfolio error")),
    );
    assert.equal(await page.getByRole("alert").count(), 0);

    await page.getByRole("button", { name: "Send", exact: true }).click();
    const prepare = async () => {
      await page.getByLabel("Recipient address").fill(`0x${"33".repeat(32)}`);
      await page.getByLabel("Amount", { exact: true }).fill("1");
      await page
        .getByRole("button", { name: "Review transfer", exact: true })
        .click();
    };
    await prepare();
    await page.waitForFunction(() => window.preparations.length === 1);
    await page.locator("#account").selectOption(`0x${"22".repeat(32)}`);
    await page.evaluate(() => window.preparations[0].resolve());
    await page
      .getByRole("button", { name: "Review transfer", exact: true })
      .waitFor();
    assert.equal(await page.locator(".review").count(), 0);

    await prepare();
    await page.waitForFunction(() => window.preparations.length === 2);
    await page.evaluate(() =>
      window.changeState({ network: "devnet", networkHash: "44".repeat(32) }),
    );
    await page.waitForFunction(
      () => document.querySelector("#network").value === "devnet",
    );
    await page.evaluate(() =>
      window.preparations[1].reject(new Error("Stale preparation error")),
    );
    await page
      .getByRole("button", { name: "Review transfer", exact: true })
      .waitFor();
    assert.equal(await page.locator(".review").count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);

    await prepare();
    await page.waitForFunction(() => window.preparations.length === 3);
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await page.getByRole("button", { name: "Unlock wallet" }).waitFor();
    await page.evaluate(() => window.preparations[2].resolve());
    await page.evaluate(() =>
      window.changeState({ unlocked: true, expires: Date.now() + 600000 }),
    );
    await page
      .getByRole("button", { name: "Review transfer", exact: true })
      .waitFor();
    assert.equal(await page.locator(".review").count(), 0);
    await prepare();
    await page.waitForFunction(() => window.preparations.length === 4);
    // Exercise overlapping submissions independently of the disabled button.
    await page
      .locator('form:has(input[name="receiver"])')
      .evaluate((form) =>
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
    await page.waitForFunction(() => window.preparations.length === 5);
    await page.evaluate(() => window.preparations[4].resolve());
    await page
      .getByRole("button", { name: "Sign and send", exact: true })
      .waitFor();
    assert.equal(
      await page.locator('dt:has-text("Transaction nonce") + dd').textContent(),
      "4",
    );
    await page.evaluate(() =>
      window.preparations[3].reject(new Error("Superseded preparation error")),
    );
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(
      await page.locator('dt:has-text("Transaction nonce") + dd').textContent(),
      "4",
    );
    const originalScope = await page.evaluate(async () => {
      const { network, networkHash, expires } = (
        await chrome.runtime.sendMessage({ op: "state" })
      ).result;
      return { network, networkHash, expires };
    });
    // A completed review must stay retired when an external network change
    // returns to the exact same account/network/expiry tuple.
    await page.evaluate(() =>
      window.changeState({ network: "localnet", networkHash: "00".repeat(32) }),
    );
    await page.waitForFunction(
      () => document.querySelector("#network").value === "localnet",
    );
    assert.equal(await page.locator(".review").count(), 0);
    await page.evaluate((scope) => window.changeState(scope), originalScope);
    await page.waitForFunction(
      (network) => document.querySelector("#network").value === network,
      originalScope.network,
    );
    assert.equal(await page.locator(".review").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Sign and send", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.preparations.length), 5);

    await prepare();
    await page.waitForFunction(() => window.preparations.length === 6);
    await page.evaluate(() => window.preparations[5].resolve());
    await page
      .getByRole("button", { name: "Sign and send", exact: true })
      .waitFor();
    // External lock/unlock must invalidate a completed review even when a
    // fixture deliberately reuses the same expiry rather than a new timestamp.
    await page.evaluate(() => window.changeState({ unlocked: false }));
    await page.getByRole("button", { name: "Unlock wallet" }).waitFor();
    await page.evaluate(() => window.changeState({ unlocked: true }));
    await page
      .getByRole("button", { name: "Review transfer", exact: true })
      .waitFor();
    assert.equal(await page.locator(".review").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Sign and send", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        async () =>
          (await chrome.runtime.sendMessage({ op: "state" })).result.expires,
      ),
      originalScope.expires,
    );
  } finally {
    await page.close();
  }
}
