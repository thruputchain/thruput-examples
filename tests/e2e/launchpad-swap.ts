// Explicit live check: npm run test:launchpad-swap (generate both apps' bindings first).
//
// Drives both apps in a browser with a test wallet that signs: launch two
// tokens in Launchpad, follow its "Create AMM Pool" link to Swap, create the
// pool, swap, add liquidity across a reload, and remove liquidity.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import {
  createPubkeyAccount,
  createWalletClient,
  Ed25519Signer,
  hashSignedTransaction,
  serializeSignedTransaction,
  signTransaction,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  parseProviderRequest,
  parseSignedTransactionHex,
  parseTransactionHex,
} from "@thruputchain/client/provider";
import { networkHash, sha256Hash } from "@thruputchain/protocol";
import { setup as setupLaunchpad } from "../../apps/token-launchpad/scripts/index";
import { setup as setupSwap } from "../../apps/swap/scripts/index";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-launchpad-swap-"));
const groups = new OwnedProcessGroups();
const servers: ViteDevServer[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let interrupted = false;

async function cleanup() {
  await Promise.allSettled([
    browser?.close(),
    ...servers.map((server) => server.close()),
    groups.stopAll(),
  ]);
}
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void cleanup();
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 420_000);

try {
  const rpcUrl = await startNode();
  const launchpadEnv = join(work, "launchpad.env");
  const swapEnv = join(work, "swap.env");
  const launch = await setupLaunchpad({
    THRUPUT_RPC_URL: rpcUrl,
    LAUNCHPAD_APP_ENV: launchpadEnv,
    LAUNCHPAD_APP_PUBLIC_DIR: await publicCopy("token-launchpad"),
  });
  await setupSwap({
    THRUPUT_RPC_URL: rpcUrl,
    SWAP_APP_ENV: swapEnv,
    SWAP_APP_PUBLIC_DIR: await publicCopy("swap"),
  });
  const client = launch.client;
  assert.ok(!interrupted, "Interrupted");

  // One funded test account signs everything.
  const signer = new Ed25519Signer(randomBytes(32));
  const account = createPubkeyAccount({ signer });
  assert.equal(
    (await createWalletClient({ client, account }).requestAirdrop()).attemptStatus,
    "succeeded",
  );
  const walletAccount = {
    address: toBase58(account.address),
    publicKey: toBase58(signer.publicKey.ed25519),
    nonce: "0",
  };
  const network = toBase58(client.network.networkHash);

  // Each dev server reads its settings from process.env.
  Object.assign(
    process.env,
    parseEnv(await readFile(launchpadEnv, "utf8")),
    parseEnv(await readFile(swapEnv, "utf8")),
    { THRUPUT_RPC_URL: rpcUrl, VITE_THRUPUT_RPC_URL: rpcUrl },
  );
  const swapOrigin = await serve("swap", join(work, "swap-public"));
  process.env.VITE_SWAP_APP_URL = `${swapOrigin}/`;
  process.env.TOKEN_REGISTRY_DB_PATH = join(work, "tokens.sqlite");
  const launchOrigin = await serve("token-launchpad", join(work, "token-launchpad-public"));

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let signatures = 0;
  // Broadcasts to let through before the wallet holds one; null holds none.
  let passBeforeHold: number | null = null;
  let held: { signedTransaction: string; release: () => void } | null = null;
  let onHeld: (() => void) | null = null;
  async function broadcast(signedTransaction: string) {
    return toBase58(
      (
        await client.sendTransaction({
          signedTransaction: serializeSignedTransaction(
            parseSignedTransactionHex(signedTransaction),
          ),
        })
      ).transactionHash,
    );
  }
  await page.exposeFunction("testWalletRequest", async (input: unknown) => {
    const request = parseProviderRequest(input);
    if (request.method === "signTransaction") {
      const signed = await signTransaction(
        parseTransactionHex(request.params.transaction),
        [{ signer, publicKeyId: 0n }],
        networkHash(sha256Hash(client.network.networkHash)),
      );
      signatures++;
      return {
        signedTransaction: toHex0x(serializeSignedTransaction(signed)),
        hash: toBase58(hashSignedTransaction(signed)),
      };
    }
    if (request.method === "submitTransaction") {
      const { signedTransaction } = request.params;
      if (passBeforeHold !== null && passBeforeHold-- === 0) {
        passBeforeHold = null;
        // Hold this broadcast until the test releases it.
        await new Promise<void>((release) => {
          held = { signedTransaction, release };
          onHeld?.();
        });
      }
      return { hash: await broadcast(signedTransaction) };
    }
    throw new Error("Unexpected wallet request");
  });
  // A wallet that, like Thruput Freighter, supports atomic batches.
  await page.addInitScript({
    content: `(() => {
      const accounts = [${JSON.stringify(walletAccount)}];
      const networkHash = ${JSON.stringify(network)};
      let session = { networkHash, accounts: [] };
      const listeners = new Set();
      const change = next => { session = next; listeners.forEach(f => f(session)); };
      const provider = { info: { id: "test-wallet", name: "Test wallet", version: "2.0.0" },
        supportedMethods: ["getCapabilities"],
        on(event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async request(request) {
          if (request.method === "connect") { change({ networkHash, accounts }); return session; }
          if (request.method === "getSession") return session;
          if (request.method === "disconnect") { change({ networkHash, accounts: [] }); return null; }
          if (request.method === "getCapabilities") return { ...request.params, atomicBatch: { maxCalls: 16 } };
          return window.testWalletRequest(request);
        }
      };
      const announce = () => window.dispatchEvent(new CustomEvent(${JSON.stringify(ANNOUNCE_PROVIDER_EVENT)}, { detail: provider }));
      window.addEventListener(${JSON.stringify(REQUEST_PROVIDER_EVENT)}, announce); announce();
    })();`,
  });
  // Locally, Swap's dev server forwards /launchpad/api to port 5173. Here the
  // Launchpad server has another port, so forward to it.
  await page.route(`${swapOrigin}/launchpad/api/**`, (route) =>
    route.continue({
      url: route.request().url().replace(`${swapOrigin}/launchpad`, launchOrigin),
    }),
  );

  // 1. Launch two tokens.
  await page.goto(`${launchOrigin}/create`);
  await connect(page);
  const first = await launchToken(page, "ACRN", "Acorn");
  await page.getByRole("button", { name: "Create another token" }).click();
  const second = await launchToken(page, "BOLT", "Bolt");
  const link = await page.getByRole("link", { name: "Create AMM Pool" }).getAttribute("href");
  assert.equal(link, `${swapOrigin}/pools/new?tokenA=${second}`);
  assert.equal(signatures, 2, "Each launch is one transaction");

  // The indexer lists both tokens.
  await page.goto(`${launchOrigin}/tokens`);
  await page.getByText("ACRN", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText("BOLT", { exact: true }).waitFor();

  // 2. Create the pool in Swap, choosing the second token by search.
  await page.goto(link!);
  await connect(page);
  assert.equal(await page.getByLabel("Token A address").inputValue(), second);
  await page.getByRole("button", { name: "Search tokens for Token B" }).click();
  await page.getByRole("combobox", { name: "Search tokens for Token B" }).fill("ACRN");
  await page.getByRole("option", { name: /ACRN/ }).click();
  assert.equal(await page.getByLabel("Token B address").inputValue(), first);
  await page.getByLabel("Token A amount").fill("1000");
  await page.getByLabel("Token B amount").fill("2000");
  await page.getByRole("button", { name: "Review pool" }).click();
  await page.getByRole("button", { name: "Create pool" }).click();
  await done(page, /^Create .+: done$/);
  assert.equal(signatures, 4, "Pool creation is one transaction, then one crank");
  await page.getByRole("link", { name: "Open the pool" }).click();

  // 3. Swap.
  await page.getByText("Reserves").waitFor();
  await page.getByLabel(/^You pay/).fill("10");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await done(page, /^Swap .+: done$/);

  // 4. Add liquidity, and reload while the request is queued: the wallet
  // broadcasts the request, then holds the crank's broadcast.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("radio", { name: "Add liquidity" }).click();
  await page.getByLabel(/to add$/).fill("5");
  passBeforeHold = 1;
  const crankHeld = new Promise<void>((resolve) => (onHeld = resolve));
  await page.getByRole("button", { name: "Add liquidity", exact: true }).last().click();
  await crankHeld;
  const beforeReload = signatures;
  await page.reload();
  // The saved request belongs to the account, so it loads after reconnecting.
  await connect(page);
  await page.getByText("Process the queue").first().waitFor({ timeout: 60_000 });
  // The crank the wallet was sending reaches the node after the reload.
  const crank = held!;
  held = null;
  crank.release();
  await done(page, /^Add liquidity: done$/);
  assert.equal(signatures, beforeReload, "A reload never signs a new request");

  // 5. Remove all liquidity.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("radio", { name: "Remove liquidity" }).click();
  await page.getByRole("button", { name: "Max" }).click();
  await page.getByRole("button", { name: "Remove liquidity", exact: true }).last().click();
  await done(page, /^Remove liquidity: done$/);

  // 6. The pool list reads the factory.
  await page.goto(`${swapOrigin}/pools`);
  await page.getByRole("link", { name: /BOLT|ACRN/ }).first().waitFor();

  assert.deepEqual(errors, []);
  console.log(
    `Launchpad and Swap browser checks passed (${signatures} signatures). Evidence: ${work}`,
  );
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await cleanup();
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect" }).waitFor();
}

async function launchToken(page: Page, symbol: string, name: string) {
  await page.getByLabel("Symbol").fill(symbol);
  await page.getByLabel("Token name").fill(name);
  await page.getByRole("button", { name: "Review launch" }).click();
  await page.getByRole("button", { name: "Launch token" }).click();
  await done(page, `${symbol} launched`);
  const address = await page
    .getByRole("button", { name: /^Copy Token address: / })
    .getAttribute("aria-label");
  return address!.replace("Copy Token address: ", "");
}

async function done(page: Page, title: RegExp | string) {
  await page
    .getByText(title)
    .waitFor({ timeout: 90_000 })
    .catch(async (error) => {
      console.error(await page.locator("main").innerText());
      throw error;
    });
}

/** A copy of an app's public directory, so setup never writes into the repo. */
async function publicCopy(app: string) {
  const directory = join(work, `${app}-public`);
  await cp(join(root, "apps", app, "public"), directory, { recursive: true });
  return directory;
}

async function serve(app: string, publicDir: string) {
  const server = await createServer({
    root: join(root, "apps", app),
    publicDir,
    server: { port: 0, host: "127.0.0.1" },
  });
  servers.push(server);
  await server.listen();
  const socket = server.httpServer!.address();
  assert.ok(socket && typeof socket !== "string");
  return `http://127.0.0.1:${socket.port}`;
}

async function startNode(): Promise<string> {
  const child = groups.spawn(
    process.env.THRUPUT_CLI ?? "thruput",
    [
      "node",
      "--json",
      "--port",
      "0",
      ...(process.env.THRUPUT_DEVNODE_BINARY
        ? ["--hog-devnode-binary", process.env.THRUPUT_DEVNODE_BINARY]
        : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(work, "config"),
        XDG_DATA_HOME: join(work, "data"),
        XDG_CACHE_HOME: join(work, "cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.ok(!interrupted, "Interrupted");
    assert.equal(child.exitCode, null, `Node stopped: ${stderr}`);
    try {
      const startup = JSON.parse(stdout) as { data?: { rpcUrl?: string } };
      if (startup.data?.rpcUrl) return startup.data.rpcUrl;
    } catch {
      /* Wait for the complete startup message. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Node startup timed out: ${stderr}`);
}
