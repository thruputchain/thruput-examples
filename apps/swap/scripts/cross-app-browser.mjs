import assert from "node:assert/strict";

export async function browserJourney({
  browser,
  so,
  lo,
  s,
  l,
  until,
  catchUp,
  outage,
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  let writes = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.url().endsWith("/groundhog-rpc") &&
      request.postDataJSON()?.method === "groundhog_sendRawTransaction"
    )
      writes++;
  });
  const name = `Cross App ${Date.now()}`;
  const symbol = "XAPP";
  const counter = s.VITE_KNOWN_TOKEN_ADDRESSES.split(",")[2];
  await page.goto(`${lo}/create`);
  for (const [label, value] of [
    ["Token name", name],
    ["Symbol", symbol],
    ["Decimals", "6"],
    ["Initial supply", "1000000"],
  ]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  assert.equal(
    await page
      .getByRole("link", { name: "Create AMM Pool", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Review launch", exact: true })
    .click();
  await page.getByRole("button", { name: "Launch token", exact: true }).click();
  const cta = page.getByRole("link", { name: "Create AMM Pool", exact: true });
  await cta.waitFor();
  await page
    .getByText(
      "Receipt, events, metadata, supply, and holder balance match this launch.",
      { exact: true },
    )
    .waitFor();
  const launch = await page.evaluate(() =>
    Object.values(localStorage)
      .map((v) => {
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      })
      .find(
        (v) =>
          v?.creation?.status === "committed" &&
          v?.verification?.status === "complete",
      ),
  );
  assert.ok(launch);
  const token = launch.createdAddressHex;
  assert.match(token, /^0x[0-9a-f]{64}$/);
  const url = `${so}/pools/new?tokenA=${token}`;
  assert.equal(await cta.getAttribute("href"), url);
  const search = async (origin, q) => {
    const response = await fetch(
      `${origin}/api/token-discovery?q=${encodeURIComponent(q)}`,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual((await search(so, token)).tokens, []);
  const beforePreset = writes;
  await cta.click();
  await page.waitForURL(url);
  const addresses = page.getByLabel("Contract address", { exact: true });
  const amounts = page.getByLabel("Initial amount", { exact: true });
  await page.getByText(`Live name: ${name}`, { exact: true }).waitFor();
  await page.getByText(`Live symbol: ${symbol}`, { exact: true }).waitFor();
  await page.getByText("Decimals: 6", { exact: true }).waitFor();
  assert.equal(await addresses.first().inputValue(), token);
  assert.equal(await addresses.nth(1).inputValue(), "");
  assert.deepEqual(
    await amounts.evaluateAll((nodes) => nodes.map((n) => n.value)),
    ["", ""],
  );
  assert.equal(writes, beforePreset);
  assert.equal(
    await page
      .getByRole("button", { name: "Create pool", exact: true })
      .count(),
    0,
  );
  assert.equal(page.url(), url);
  // The setup ERC20 is compatible but outside the launchpad factory index.
  assert.deepEqual((await search(so, counter)).tokens, []);
  await addresses.nth(1).fill(counter);
  await page.getByText("Live symbol: gJPY", { exact: true }).waitFor();
  await amounts.first().fill("10");
  await amounts.nth(1).fill("10");
  await page.getByRole("switch", { name: "Manual queue processing" }).check();
  await page.getByRole("button", { name: "Review pool", exact: true }).click();
  await page
    .getByRole("button", { name: "Create pool", exact: true })
    .waitFor();
  assert.equal(writes, beforePreset, "Review must not sign");
  await page.getByRole("button", { name: "Create pool", exact: true }).click();
  await page
    .getByRole("button", { name: "Process liquidity queue", exact: true })
    .waitFor();
  const recoveredUrl = `${so}/pools/new?tokenA=${counter}&tokenB=${s.VITE_KNOWN_TOKEN_ADDRESSES.split(",")[0]}`;
  const beforeRecovery = writes;
  await page.goto(recoveredUrl);
  await page
    .getByText(/saved creation.*recovered|Recovering a saved/i)
    .waitFor();
  assert.equal(await page.getByText(/^Live name:/).count(), 0);
  assert.equal(writes, beforeRecovery);
  await page
    .getByRole("button", { name: "Process liquidity queue", exact: true })
    .click();
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/pools/") && url.pathname !== "/pools/new",
  );
  await page.getByText("Your LP share", { exact: true }).waitFor();
  const workflow = await page.evaluate(() =>
    Object.values(localStorage)
      .map((v) => {
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      })
      .find((v) => v?.steps?.createPool && v.status === "executed"),
  );
  assert.ok(workflow?.pool);
  assert.deepEqual(
    [workflow.token0.address, workflow.token1.address].sort(),
    [token, counter].sort(),
  );
  console.log(
    `PASS live launch -> verified CTA click -> unindexed live preview -> manual ERC20 -> explicit review/create -> queued recovery -> seed: token=${token} pool=${workflow.pool.handler}`,
  );
  await page.goto(`${so}/pools/new`);
  await addresses.first().waitFor();
  assert.deepEqual(
    await addresses.evaluateAll((nodes) => nodes.map((n) => n.value)),
    ["", ""],
  );
  await catchUp();
  await until(
    async () =>
      (await search(so, token)).tokens.some(
        (row) => row.tokenAddress === token,
      ),
    "registry indexing",
  );
  for (const query of [
    name,
    symbol,
    token,
    token.slice(0, 20),
    l.VITE_GROUNDHOG_WALLET_ADDRESS,
  ]) {
    const result = await search(so, query);
    const row = result.tokens.find((row) => row.tokenAddress === token);
    assert.equal(row?.name, name);
    assert.equal(row?.symbol, symbol);
    assert.equal(row?.decimals, 6);
    await page
      .getByRole("button", { name: "Search Token A", exact: true })
      .click();
    const input = page.getByRole("combobox", {
      name: "Search Token A",
      exact: true,
    });
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/token-discovery" &&
        new URL(r.url()).searchParams.get("q") === query &&
        r.status() === 200,
    );
    await input.fill(query);
    await response;
    await page.getByRole("option").filter({ hasText: name }).waitFor();
    await input.press("ArrowDown");
    await input.press("Enter");
    await page.getByText(`Live name: ${name}`, { exact: true }).waitFor();
    assert.equal(await addresses.first().inputValue(), token);
  }
  console.log(
    "PASS indexed name/symbol/full+partial address/creator search and keyboard selection through Vite proxy",
  );
  const fresh = async (query) => {
    await page.goto(`${so}/pools/new?${query}`);
    await addresses.first().waitFor();
  };
  await fresh(`tokenA=${counter}&tokenB=${token}`);
  await page.getByText(`Live name: ${name}`, { exact: true }).waitFor();
  await page.getByText("Live symbol: gJPY", { exact: true }).waitFor();
  assert.deepEqual(
    await addresses.evaluateAll((nodes) => nodes.map((n) => n.value)),
    [counter, token],
  );
  await amounts.first().fill("1");
  await amounts.nth(1).fill("1");
  await page.getByRole("button", { name: "Review pool", exact: true }).click();
  await page
    .getByText("A pool for these tokens already exists", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Create pool", exact: true })
      .count(),
    0,
  );
  await fresh(`tokenA=invalid&tokenB=${token}`);
  assert.equal(await addresses.first().inputValue(), "");
  assert.equal(await addresses.nth(1).inputValue(), token);
  await fresh(`tokenA=${token}&tokenB=${token}`);
  assert.equal(await addresses.first().inputValue(), token);
  assert.equal(await addresses.nth(1).inputValue(), "");
  await addresses.nth(1).fill(token);
  assert.equal(
    await page
      .getByRole("button", { name: "Review pool", exact: true })
      .isDisabled(),
    true,
  );
  await outage();
  await page
    .getByRole("button", { name: "Search Token B", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Search Token B", exact: true })
    .fill(counter);
  await page
    .getByText("Token discovery is unavailable. Try again or use an address.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("option", { name: `Use address ${counter}`, exact: true })
    .click();
  await page.getByText("Live symbol: gJPY", { exact: true }).waitFor();
  assert.equal(await addresses.first().inputValue(), token);
  console.log(
    "PASS two presets, malformed/duplicate input, existing-pair rejection, real upstream outage/manual fallback",
  );
  assert.deepEqual(errors, []);
  await context.close();
  return {
    network: s.VITE_GROUNDHOG_NETWORK_ID,
    token,
    counter,
    name,
    symbol,
    creator: l.VITE_GROUNDHOG_WALLET_ADDRESS,
    pool: workflow.pool,
    writes,
  };
}

export async function productionSmoke({ browser, sr, lr, evidence }) {
  for (const [origin, creation, directory] of [
    [sr, `/pools/new?tokenA=${evidence.token}`, "/pools"],
    [lr, "/create", "/tokens"],
  ]) {
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.ok(
      response.headers
        .get("content-security-policy")
        .includes("connect-src 'self'"),
    );
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const manifest = await fetch(`${origin}/groundhog-public-config.json`);
    assert.equal(manifest.status, 200);
    const publicConfig = await manifest.json();
    assert.equal(
      publicConfig.VITE_GROUNDHOG_NETWORK_ID,
      evidence.network.replace(/^0x/, ""),
    );
    assert.equal(publicConfig.TOKEN_DISCOVERY_UPSTREAM_ORIGIN, undefined);
    const denied = await fetch(`${origin}/groundhog-rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_sendRawTransaction",
        params: [],
      }),
    });
    assert.equal(denied.status, 403);
    const context = await browser.newContext();
    const page = await context.newPage();
    const methods = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/groundhog-rpc"))
        methods.push(r.postDataJSON()?.method);
    });
    await page.goto(`${origin}${creation}`);
    await page.waitForURL(`${origin}${directory}`);
    assert.equal(
      await page.getByLabel("Contract address", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: /Review pool|Review launch|Launch token/ })
        .count(),
      0,
    );
    assert.ok(!methods.includes("groundhog_sendRawTransaction"));
    if (origin === sr) {
      const result = await page.evaluate(async (token) => {
        const r = await fetch(`/api/token-discovery?q=${token}`);
        return { status: r.status, body: await r.json() };
      }, evidence.token);
      assert.equal(result.status, 200);
      assert.ok(
        result.body.tokens.some((t) => t.tokenAddress === evidence.token),
      );
    }
    await context.close();
  }
  for (const [suffix, method, status] of [
    ["", "POST", 405],
    ["?url=http://127.0.0.1", "GET", 400],
    ["?q=a&q=b", "GET", 400],
  ]) {
    const response = await fetch(`${sr}/api/token-discovery${suffix}`, {
      method,
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const text = await response.text();
    assert.ok(!text.includes(lr));
    assert.ok(Buffer.byteLength(text) < 600);
  }
  console.log(
    "PASS both real production servers: SPA, CSP, no signing/preset controls, redirects, RPC write rejection, same-origin discovery and query/method sanitization",
  );
}

export async function scopeSmoke({ browser, origin, kind, evidence }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    let writes = 0;
    page.on("request", (r) => {
      if (
        r.url().endsWith("/groundhog-rpc") &&
        r.postDataJSON()?.method === "groundhog_sendRawTransaction"
      )
        writes++;
    });
    const response = await fetch(
      `${origin}/api/token-discovery?q=${evidence.token}`,
    );
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes("http:"));
    const url = `${origin}/pools/new?tokenA=${evidence.token}&tokenB=${evidence.counter}`;
    await page.goto(url);
    if (kind === "network") {
      await page
        .getByText("RPC network mismatch. Check the connection and retry.")
        .first()
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Review pool", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByText(`Live name: ${evidence.name}`, { exact: true })
          .count(),
        0,
      );
    } else {
      await page
        .getByText(`Live name: ${evidence.name}`, { exact: true })
        .waitFor();
      await page.getByText("Live symbol: gJPY", { exact: true }).waitFor();
    }
    assert.equal(page.url(), url);
    assert.equal(writes, 0);
    console.log(
      `PASS live ${kind} mismatch: discovery fails closed; ${kind === "network" ? "preview/review blocked" : "manual live metadata remains independent"}`,
    );
  } finally {
    await context.close();
  }
}
