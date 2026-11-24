// End-to-end check of the NFT Drop app on an isolated local node:
// setup, wallet creation and minting in a browser, and rushes that must mint
// concurrently without conflicts and sell out exactly.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
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
  addressFromBase58,
} from "@thruputchain/client";
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  parseProviderRequest,
  parseSignedTransactionHex,
  parseTransactionHex,
} from "@thruputchain/client/provider";
import { networkHash, sha256Hash } from "@thruputchain/protocol";
import { setup } from "../../apps/nft-drop/scripts/index";
import { NftDrop } from "../../apps/nft-drop/src/contracts/drops";
import type { RushSnapshot } from "../../apps/nft-drop/server/rush";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-nft-drop-"));
const groups = new OwnedProcessGroups();
const CROWD = 300;
let server: ViteDevServer | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let interrupted = false;

async function cleanup() {
  const results = await Promise.allSettled([
    browser?.close(),
    server?.close(),
    groups.stopAll(),
  ]);
  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  if (errors.length)
    throw new AggregateError(errors, "NFT Drop cleanup failed");
}
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void cleanup().catch(console.error);
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 600_000);

try {
  const rpcUrl = await startNode();
  const deployment = await setup({
    THRUPUT_RPC_URL: rpcUrl,
    NFT_DROP_APP_ENV: join(work, "nft-drop.env"),
    NFT_CROWD_SIZE: String(CROWD),
  });
  await checkBrowser(deployment);
  console.log(`NFT Drop end-to-end checks passed. Evidence: ${work}`);
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await cleanup();
}

type Deployment = NonNullable<Awaited<ReturnType<typeof setup>>>;

async function checkBrowser({ client, demoDrop, output }: Deployment) {
  Object.assign(process.env, parseEnv(await readFile(output, "utf8")));

  // A wallet that signs with a funded test key, like Thruput Freighter.
  const signer = new Ed25519Signer(randomBytes(32));
  const account = createPubkeyAccount({ signer });
  const funding = createWalletClient({ client, account });
  for (let i = 0; i < 5; i++)
    await funding.requestAirdrop({ timeoutMs: 60_000 });
  const accounts = [
    {
      address: toBase58(account.address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    },
  ];
  const network = toBase58(client.network.networkHash);

  server = await createServer({
    root: join(root, "apps/nft-drop"),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const socket = server.httpServer!.address();
  assert(socket && typeof socket !== "string");
  const origin = `http://127.0.0.1:${socket.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("nftDropWalletRequest", async (input: unknown) => {
    const request = parseProviderRequest(input);
    if (request.method === "signTransaction") {
      assert.equal(request.params.account, accounts[0]!.address);
      const signed = await signTransaction(
        parseTransactionHex(request.params.transaction),
        [{ signer, publicKeyId: 0n }],
        networkHash(sha256Hash(client.network.networkHash)),
      );
      return {
        signedTransaction: toHex0x(serializeSignedTransaction(signed)),
        hash: toBase58(hashSignedTransaction(signed)),
      };
    }
    if (request.method === "submitTransaction") {
      const sent = await client.sendTransaction({
        signedTransaction: serializeSignedTransaction(
          parseSignedTransactionHex(request.params.signedTransaction),
        ),
      });
      return { hash: toBase58(sent.transactionHash) };
    }
    throw new Error(`Unexpected wallet request ${request.method}`);
  });
  await page.addInitScript({
    content: `(() => {
      const accounts = ${JSON.stringify(accounts)}, networkHash = ${JSON.stringify(network)};
      let session = { networkHash, accounts: [] }; const listeners = new Set();
      const change = next => { session = next; listeners.forEach(f => f(session)); };
      const provider = { info: { id: "nft-drop-test", name: "NFT Drop test wallet", version: "2.0.0" },
        // Like Thruput Freighter: the client asks for capabilities only if they are listed.
        supportedMethods: ["getCapabilities"],
        on(event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async request(request) {
          if (request.method === "connect") { change({ networkHash, accounts }); return session; }
          if (request.method === "getSession") return session;
          if (request.method === "disconnect") { change({ networkHash, accounts: [] }); return null; }
          // Thruput Freighter executes up to 16 calls atomically.
          if (request.method === "getCapabilities") return { ...request.params, atomicBatch: { maxCalls: 16 } };
          return window.nftDropWalletRequest(request);
        }
      };
      const announce = () => window.dispatchEvent(new CustomEvent(${JSON.stringify(ANNOUNCE_PROVIDER_EVENT)}, { detail: provider }));
      window.addEventListener(${JSON.stringify(REQUEST_PROVIDER_EVENT)}, announce); announce();
    })();`,
  });
  const fail = async (step: string, error: unknown) => {
    await page.screenshot({
      path: join(work, `failed-${step}.png`),
      fullPage: true,
    });
    console.error(step, await page.locator("main").innerText(), errors);
    throw error;
  };

  // The demo drop is listed.
  await page.goto(origin);
  await page.getByRole("heading", { name: "Thruput Grid" }).waitFor();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();

  // Create a drop in one wallet transaction: fund its address, then create it.
  await page.getByRole("link", { name: "New drop" }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("E2E Grid");
  await page.getByLabel("Symbol", { exact: true }).fill("E2E");
  await page.getByLabel("Supply", { exact: true }).fill("150");
  // Traits can be reweighted and removed, but not added.
  await page.getByRole("button", { name: "Remove trait Accent" }).click();
  await page.getByRole("button", { name: "Remove Gold" }).click();
  await page.getByLabel("Bauhaus weight").fill("50");
  assert.equal(await page.getByRole("button", { name: /^Add/ }).count(), 0);
  await page.getByText(/native tokens$/).waitFor();
  await page.getByRole("button", { name: "Create drop" }).click();
  await page
    .getByRole("heading", { name: "E2E Grid" })
    .waitFor({ timeout: 60_000 })
    .catch((e) => fail("create", e));
  const drop = new URL(page.url()).pathname.split("/").at(-1)!;

  // Mint one with the wallet.
  await page.getByRole("button", { name: "Mint one" }).click();
  await page
    .getByText("You minted a token.")
    .waitFor({ timeout: 60_000 })
    .catch((e) => fail("mint", e));
  await page
    .getByText("1 / 150 minted")
    .waitFor({ timeout: 20_000 })
    .catch((e) => fail("mint-count", e));

  // Rush 200 users against the 149 tokens left. Excluded users resubmit
  // their signed mint, so every user ends minted or sold out: exactly 149
  // mint, and the other 51 see SoldOut.
  const sellOut = await rush(page, origin, { users: "200", window: "2" });
  assert.equal(sellOut.outcomes.minted, 149, JSON.stringify(sellOut));
  assert.equal(sellOut.outcomes.soldOut, 51, JSON.stringify(sellOut));
  assert.equal(
    sellOut.outcomes.notIncluded +
      sellOut.outcomes.failed +
      sellOut.outcomes.pending,
    0,
    JSON.stringify(sellOut),
  );
  assert.equal(
    sellOut.exclusions.other,
    0,
    "mints must not conflict with each other",
  );
  assert.ok(
    sellOut.blocks.some((b) => b.minted > 1),
    "several mints must share a block",
  );
  const { value: remaining } = await NftDrop.v0_1.remaining.view({
    client,
    address: addressFromBase58(drop),
    minStateBlockHeight: (await client.getChainTip()).blockHeight,
  });
  assert.equal(remaining, 0n);
  await page.getByText("Sold out").first().waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(work, "sell-out.png"), fullPage: true });

  // Rush the whole crowd at once against the demo drop: every mint lands.
  await page.goto(`${origin}/drops/${toBase58(demoDrop)}`);
  const burst = await rush(page, origin, { users: String(CROWD), window: "0" });
  assert.equal(burst.outcomes.minted, CROWD, JSON.stringify(burst));
  assert.equal(
    burst.exclusions.other + burst.outcomes.failed + burst.outcomes.notIncluded,
    0,
    JSON.stringify(burst),
  );
  assert.ok(
    burst.blocks.length <= 2,
    `expected one or two blocks, got ${JSON.stringify(burst.blocks)}`,
  );
  // The gallery shows the new tokens.
  await page
    .locator("button.token")
    .first()
    .waitFor({ timeout: 20_000 })
    .catch((e) => fail("gallery", e));
  await page.locator("button.token").first().click();
  await page.getByRole("dialog").getByText("Owner").waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(work, "burst.png"), fullPage: true });

  assert.deepEqual(errors, []);
}

/** Start a rush from the page and wait for the server to finish it. */
async function rush(
  page: Page,
  origin: string,
  input: { users: string; window: string },
) {
  await page.getByLabel("Users").fill(input.users);
  await page.getByLabel("Window (seconds)").fill(input.window);
  await page.getByRole("button", { name: "Start rush" }).click();
  await page.getByText(/^Finished:/).waitFor({ timeout: 120_000 });
  const body = (await (await fetch(`${origin}/api/rush`)).json()) as {
    rush: RushSnapshot;
  };
  const { outcomes, blocks, resubmitted, exclusions } = body.rush;
  console.log(
    `Rush of ${input.users} over ${input.window} s:`,
    JSON.stringify({ outcomes, blocks, resubmitted, exclusions }),
  );
  assert.equal(body.rush.phase, "done", body.rush.message ?? "");
  return body.rush;
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
    assert.ok(!interrupted, "NFT Drop checks interrupted");
    assert.equal(child.exitCode, null, `Node stopped: ${stderr}`);
    try {
      const startup = JSON.parse(stdout) as { data?: { rpcUrl?: string } };
      if (startup.data?.rpcUrl) return startup.data.rpcUrl;
    } catch {
      // Not complete JSON yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Node did not start: ${stderr}`);
}
