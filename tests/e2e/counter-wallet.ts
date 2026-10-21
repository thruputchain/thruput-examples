// Controlled provider + real local transactions; no extension or tutorial checkout.
import assert from "node:assert/strict";
import { networkHash, sha256Hash } from "@thruputchain/protocol";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";
import {
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  localnet,
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
import { setup } from "../../apps/counter/scripts/setup-local.ts";
import { loadServerConfig } from "../../apps/counter/server/config.ts";
import { createCounterServer } from "../../apps/counter/server/main.ts";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

assert.ok(process.env.THRUPUT_CLI, "Set THRUPUT_CLI");
assert.ok(process.env.THRUPUT_DEVNODE_BINARY, "Set THRUPUT_DEVNODE_BINARY");
const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-counter-wallet-"));
const groups = new OwnedProcessGroups();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createCounterServer> | undefined;
let reportPage = async () => {};
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  void groups.stopAll();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 180_000);
async function until(check: () => boolean | Promise<boolean>, name: string) {
  const deadline = Date.now() + 60_000;
  while (!(await check())) {
    assert.ok(!interrupted && Date.now() < deadline, `Timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
declare global {
  interface Window {
    counterWalletTest: {
      reject: boolean;
      failSubmit: boolean;
      wrongNetwork(): void;
    };
    counterWalletRequest(value: unknown): Promise<unknown>;
  }
}

try {
  const node = groups.spawn(
    process.env.THRUPUT_CLI,
    [
      "node",
      "--port",
      "0",
      "--json",
      "--hog-devnode-binary",
      process.env.THRUPUT_DEVNODE_BINARY,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: join(work, "config"),
        XDG_DATA_HOME: join(work, "data"),
        XDG_CACHE_HOME: join(work, "cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let diagnostics = "";
  node.stdout!.on("data", (data: Buffer) => {
    stdout += data;
  });
  node.stderr!.on("data", (data: Buffer) => {
    diagnostics += data;
  });
  node.on("error", (error: Error) => {
    diagnostics += error.message;
  });
  let ready:
    | {
        ok: boolean;
        data: { rpcUrl: string; runtimeManifest: { path: string } };
      }
    | undefined;
  await until(() => {
    assert.equal(node.exitCode, null, diagnostics);
    try {
      ready = JSON.parse(stdout);
    } catch {
      return false;
    }
    return ready?.ok === true;
  }, "node startup");
  const output = join(work, ".env.local");
  await setup({
    THRUPUT_RPC_URL: ready!.data.rpcUrl,
    THRUPUT_RUNTIME_MANIFEST: ready!.data.runtimeManifest.path,
    COUNTER_APP_ENV: output,
    COUNTER_ARTIFACT:
      process.env.COUNTER_ARTIFACT ??
      join(root, "target/thruput/counter.rv32a"),
  });
  const config = loadServerConfig(parseEnv(await readFile(output, "utf8")));
  const client = await createThruputClient({
    cluster: localnet({ rpcUrl: ready!.data.rpcUrl }),
  });
  const signers = [
    new PrivateKeySigner(randomBytes(32)),
    new PrivateKeySigner(randomBytes(32)),
  ];
  const accounts: WalletAccount[] = [];
  for (const signer of signers) {
    const account = createPubkeyAccount({ signer });
    const result = await createWalletClient({
      client,
      account,
    }).requestAirdrop();
    assert.equal(result.attemptStatus, "succeeded");
    accounts.push({
      address: toBase58(account.address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    });
  }
  const network = toBase58(client.network.networkHash);
  const otherNetwork = toBase58(new Uint8Array(32).fill(0x11));
  server = createCounterServer(config);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const socket = server.address();
  assert.ok(socket && typeof socket !== "string");
  const origin = `http://127.0.0.1:${socket.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
  });
  const page = await browser.newPage();
  reportPage = async () => {
    console.error(
      "Visible alerts:",
      await page.getByRole("alert").allTextContents(),
    );
    await page.screenshot({ path: join(work, "failure.png"), fullPage: true });
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let developmentRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/prepare")) developmentRequests++;
  });
  const signatures: string[] = [];
  const submissions: string[] = [];
  await page.exposeFunction("counterWalletRequest", async (value: unknown) => {
    const request = parseProviderRequest(value);
    if (request.method === "signTransaction") {
      const index = accounts.findIndex(
        (account) => account.address === request.params.account,
      );
      assert.ok(index >= 0);
      const signed = await signTransaction(
        parseTransactionHex(request.params.transaction),
        [{ signer: signers[index]!, publicKeyId: 0n }],
        networkHash(sha256Hash(client.network.networkHash)),
      );
      const hash = toBase58(hashSignedTransaction(signed));
      signatures.push(hash);
      return {
        signedTransaction: toHex0x(serializeSignedTransaction(signed)),
        hash,
      };
    }
    if (request.method === "submitTransaction") {
      const signed = parseSignedTransactionHex(
        request.params.signedTransaction,
      );
      submissions.push(toBase58(hashSignedTransaction(signed)));
      return {
        hash: toBase58(
          (
            await client.sendTransaction({
              signedTransaction: serializeSignedTransaction(signed),
            })
          ).transactionHash,
        ),
      };
    }
    throw new Error("Unexpected provider bridge request");
  });
  await page.addInitScript({
    content: `(() => {
    const network = ${JSON.stringify(network)};
    const otherNetwork = ${JSON.stringify(otherNetwork)};
    const accounts = ${JSON.stringify(accounts)};
    let session = { networkHash: network, accounts: [] };
    const listeners = new Set();
    const change = next => { session = next; listeners.forEach(listener => listener(session)); };
    window.counterWalletTest = { reject: false, failSubmit: false, wrongNetwork: () => change({ networkHash: otherNetwork, accounts }) };
    const provider = {
      info: { id: "counter-live-test", name: "Counter live test wallet", version: "2.0.0" },
      on(_event, listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async request(request) {
        if (request.method === "connect") { change({ networkHash: network, accounts }); return session; }
        if (request.method === "disconnect") { change({ networkHash: network, accounts: [] }); return null; }
        if (request.method === "getSession") return session;
        if (request.method === "getCapabilities") throw { code: 4200, message: "No batching in this test provider" };
        if (request.method === "signTransaction" && window.counterWalletTest.reject) throw { code: 4001, message: "Test wallet rejected the update" };
        if (request.method === "submitTransaction" && window.counterWalletTest.failSubmit) throw { code: -32603, message: "Test submission failed before broadcast" };
        return window.counterWalletRequest(request);
      },
    };
    const announce = () => window.dispatchEvent(new CustomEvent("groundhog:announceProvider", { detail: provider }));
    window.addEventListener("groundhog:requestProvider", announce);
    announce();
  })();`,
  });

  const increment = page.getByRole("button", {
    name: "Increment",
    exact: true,
  });
  const value = page.getByTestId("counter-value");
  const expectValue = (expected: number) =>
    until(
      async () =>
        Number((await value.textContent())?.replaceAll(",", "")) === expected,
      `counter ${expected}`,
    );
  await page.goto(origin);
  await expectValue(1_000_000);
  assert.deepEqual(errors, []);
  await increment.click();
  await expectValue(1_000_001);
  assert.equal(developmentRequests, 1);
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page
    .locator("header")
    .getByRole("button", { name: "Disconnect wallet", exact: true })
    .waitFor();
  await increment.click();
  await page.getByText("Counter update committed.", { exact: true }).waitFor();
  await expectValue(1_000_002);
  await page.reload();
  await page.getByText("Counter update committed.", { exact: true }).waitFor();
  assert.equal(signatures.length, 1);
  assert.equal(submissions.length, 1);
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page
    .getByRole("region", { name: "Transaction activity" })
    .getByText("Confirmed", { exact: true })
    .last()
    .waitFor();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.evaluate(() => {
    window.counterWalletTest.failSubmit = true;
  });
  await increment.click();
  await until(
    () =>
      page.getByRole("button", { name: "Retry same transaction" }).isEnabled(),
    "failed submission recovery controls",
  );
  const original = signatures.at(-1)!;
  assert.equal(submissions.length, 1);
  await expectValue(1_000_002);
  await page.reload();
  await page.getByRole("button", { name: "Retry same transaction" }).waitFor();
  assert.equal(signatures.length, 2, "Reload must not sign or submit");
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page
    .locator('select[name="account"]')
    .selectOption(accounts[1]!.address);
  await page.getByRole("button", { name: "Retry same transaction" }).click();
  await page
    .getByText(
      "Select the original wallet account and network before retrying.",
      { exact: true },
    )
    .waitFor();
  assert.equal(signatures.length, 2);
  await page
    .locator('select[name="account"]')
    .selectOption(accounts[0]!.address);
  await page.getByRole("button", { name: "Retry same transaction" }).click();
  await page.getByText("Counter update committed.", { exact: true }).waitFor();
  assert.equal(signatures.at(-1), original);
  assert.equal(submissions.at(-1), original);
  await expectValue(1_000_003);
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page
    .getByRole("region", { name: "Transaction activity" })
    .getByText("Confirmed", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.counterWalletTest.reject = true;
  });
  await increment.click();
  await page
    .getByText("Test wallet rejected the update", { exact: true })
    .waitFor();
  assert.equal(
    developmentRequests,
    1,
    "Wallet rejection must not use development signing",
  );
  await page.evaluate(() => window.counterWalletTest.wrongNetwork());
  await page
    .getByText("Select the application's network in your wallet.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await increment.isDisabled(), true);
  await page
    .getByRole("button", { name: "Disconnect wallet", exact: true })
    .click();
  await page
    .locator("header")
    .getByRole("button", { name: "Connect wallet", exact: true })
    .waitFor();
  await page
    .locator("header")
    .getByRole("button", { name: /^Top up Signer/ })
    .waitFor();
  await increment.click();
  await expectValue(1_000_004);
  assert.equal(developmentRequests, 2);

  const storageKey = `counter-wallet:v1:${network}:${config.app.counterAddress}`;
  await page.evaluate(
    (key) => localStorage.setItem(key, "corrupt"),
    storageKey,
  );
  await page.reload();
  await page.getByRole("button", { name: "Retry storage" }).waitFor();
  await page.getByRole("button", { name: "Forget saved record" }).click();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
    "corrupt",
  );
  await page.getByRole("button", { name: "Confirm forget record" }).click();
  await until(
    async () =>
      (await page.evaluate((key) => localStorage.getItem(key), storageKey)) ===
      null,
    "storage reset",
  );
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await increment.click();
  await page.getByText("Counter update committed.", { exact: true }).waitFor();
  await expectValue(1_000_005);
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = createCounterServer({
    ...config,
    signingPrivateKey: null,
    app: { ...config.app, signerAddress: null },
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const keylessSocket = server.address();
  assert.ok(keylessSocket && typeof keylessSocket !== "string");
  await page.goto(`http://127.0.0.1:${keylessSocket.port}`);
  await expectValue(1_000_005);
  assert.equal(await increment.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: /^Top up Signer/ }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await increment.click();
  await page.getByText("Counter update committed.", { exact: true }).waitFor();
  await expectValue(1_000_006);
  assert.equal(
    developmentRequests,
    2,
    "Keyless wallet mode must not request development signatures",
  );
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: join(work, `counter-wallet-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS Counter wallet: mode switching, no fallback, observation-only reload, same-hash recovery, account/network guards, storage reset, keyless wallet mode, mobile/desktop",
  );
} catch (error) {
  await reportPage();
  throw error;
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await groups.stopAll();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  console.log(`Evidence: ${work}`);
}
