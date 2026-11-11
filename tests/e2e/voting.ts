// Explicit live check: npm run test:voting (generate Voting bindings first).
import assert from "node:assert/strict";
import {
  networkHash,
  sha256Hash,
  type ContractAddress,
  type Invocation,
} from "@thruputchain/protocol";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import {
  createPubkeyAccount,
  createWalletClient,
  Ed25519Signer,
  toBase58,
  toHex0x,
  signTransaction,
  hashSignedTransaction,
  serializeSignedTransaction,
  TransactionExecutionError,
} from "@thruputchain/client";
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  parseProviderRequest,
  parseTransactionHex,
  parseSignedTransactionHex,
  type WalletAccount,
} from "@thruputchain/client/provider";
import { setup } from "../../apps/voting/scripts/index";
import type { Client } from "../../apps/voting/scripts/run";
import {
  GAS,
  methods,
  readPoll,
  listPolls,
  type Definition,
} from "../../apps/voting/src/contracts/polls";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-voting-"));
const evidence = join(work, "screenshots");
const groups = new OwnedProcessGroups();
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
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length)
    throw new AggregateError(errors, "Voting test cleanup failed");
}

function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void cleanup().catch((error) => console.error(error));
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 240_000);

try {
  const rpcUrl = await startNode();
  assert.ok(!interrupted, "Voting checks interrupted");
  const { client, address } = await setup({
    THRUPUT_RPC_URL: rpcUrl,
    VOTING_APP_ENV: join(work, ".env.local"),
  });
  await checkContract(client, address);
  await checkBrowser(client, address, rpcUrl);
  console.log(`Voting end-to-end checks passed. Evidence: ${work}`);
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await cleanup();
}

async function startNode(): Promise<string> {
  const child = groups.spawn(
    process.env.THRUPUT_CLI ?? "thruput",
    [
      "node",
      "--json",
      "--port",
      "0",
      // Exercise SDK discovery rather than relying on the usual zero-hash network.
      "--init-network-hash",
      toBase58(new Uint8Array(32).fill(1)),
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
  let spawnError: Error | undefined;
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", (error: Error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.ok(!interrupted, "Voting checks interrupted");
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Node stopped: ${stderr}`);
    let startup: { data?: { rpcUrl?: string } } | undefined;
    try {
      startup = JSON.parse(stdout);
    } catch {
      /* Wait for the complete startup message. */
    }
    if (startup?.data?.rpcUrl) return startup.data.rpcUrl;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Node startup timed out: ${stderr}`);
}

async function checkBrowser(
  client: Client,
  address: ContractAddress,
  rpcUrl: string,
) {
  assert.ok(!interrupted, "Voting checks interrupted");
  const signers = [
    new Ed25519Signer(randomBytes(32)),
    new Ed25519Signer(randomBytes(32)),
  ];
  const accounts: WalletAccount[] = [];
  for (const signer of signers) {
    const account = createPubkeyAccount({ signer });
    assert.equal(
      (await createWalletClient({ client, account }).requestAirdrop())
        .attemptStatus,
      "succeeded",
    );
    accounts.push({
      address: toBase58(account.address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    });
  }
  const network = toBase58(client.network.networkHash);
  await mkdir(evidence, { recursive: true });
  process.env.THRUPUT_RPC_URL = rpcUrl;
  process.env.VITE_THRUPUT_NETWORK_ID = network;
  process.env.VITE_VOTING_ADDRESS = toBase58(address);
  server = await createServer({
    root: join(root, "apps/voting"),
    server: { port: 0, host: "127.0.0.1" },
  });
  await server.listen();
  assert.ok(!interrupted, "Voting checks interrupted");
  const socket = server.httpServer!.address();
  assert.ok(socket && typeof socket !== "string");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  let signatures = 0;
  try {
    await page.exposeFunction("votingWalletRequest", async (input: unknown) => {
      const request = parseProviderRequest(input);
      if (request.method === "signTransaction") {
        const index = accounts.findIndex(
          (a) => a.address === request.params.account,
        );
        assert.ok(index >= 0);
        const signed = await signTransaction(
          parseTransactionHex(request.params.transaction),
          [{ signer: signers[index]!, publicKeyId: 0n }],
          networkHash(sha256Hash(client.network.networkHash)),
        );
        signatures++;
        return {
          signedTransaction: toHex0x(serializeSignedTransaction(signed)),
          hash: toBase58(hashSignedTransaction(signed)),
        };
      }
      if (request.method === "submitTransaction")
        return {
          hash: toBase58(
            (
              await client.sendTransaction({
                signedTransaction: serializeSignedTransaction(
                  parseSignedTransactionHex(request.params.signedTransaction),
                ),
              })
            ).transactionHash,
          ),
        };
      throw new Error("Unexpected provider request");
    });
    await page.addInitScript({
      content: `(() => {
    const accounts = ${JSON.stringify(accounts)};
    const networkHash = ${JSON.stringify(network)};
    let session = { networkHash, accounts: [] };
    const listeners = new Set();
    const change = next => { session = next; listeners.forEach(f => f(session)); };
    const provider = { info: { id: "voting-test", name: "Voting test wallet", version: "2.0.0" },
      on(event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async request(request) {
        if (request.method === "connect") { change({ networkHash, accounts }); return session; }
        if (request.method === "getSession") return session;
        if (request.method === "disconnect") { change({ networkHash, accounts: [] }); return null; }
        if (request.method === "getCapabilities") throw { code: 4200, message: "No batching" };
        return window.votingWalletRequest(request);
      }
    };
    const announce = () => window.dispatchEvent(new CustomEvent(${JSON.stringify(ANNOUNCE_PROVIDER_EVENT)}, { detail: provider }));
    window.addEventListener(${JSON.stringify(REQUEST_PROVIDER_EVENT)}, announce); announce();
  })();`,
    });
    const origin = `http://127.0.0.1:${socket.port}`;
    await page.goto(origin);
    await page.getByRole("heading", { name: "Community polls" }).waitFor();
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click();
    await page.getByRole("link", { name: "Create poll", exact: true }).click();
    await page
      .getByLabel("Poll title", { exact: true })
      .fill("Developer priorities");
    await page.getByLabel("Question text", { exact: true }).fill("What next?");
    await page.getByLabel("Option 1", { exact: true }).fill("Wallet");
    await page.getByLabel("Option 2", { exact: true }).fill("Explorer");
    await page
      .getByRole("button", { name: "Add question", exact: true })
      .click();
    const second = page.getByRole("region", {
      name: "Question 2",
      exact: true,
    });
    await second.getByLabel("Question text", { exact: true }).fill("When?");
    await second.getByLabel("Option 1", { exact: true }).fill("Monday");
    await second.getByLabel("Option 2", { exact: true }).fill("Friday");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const confirmed = page
      .getByRole("status")
      .filter({ hasText: /confirmed\.$/ });
    await page
      .getByRole("heading", { name: "My polls", exact: true })
      .waitFor({ timeout: 60_000 });
    const beforeReload = signatures;
    await page.reload();
    await page
      .getByRole("heading", { name: "My polls", exact: true })
      .waitFor();
    assert.equal(
      signatures,
      beforeReload,
      "Reload must observe, not sign again",
    );
    assert.equal(
      await page.getByRole("button", { name: "Finish", exact: true }).count(),
      0,
    );
    await page.goto(`${origin}/admin`);
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click();
    await page
      .getByRole("link")
      .filter({
        has: page.getByRole("heading", { name: "Developer priorities" }),
      })
      .click();
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await page
      .getByLabel("Description (optional)")
      .fill("Choose our next development priority.");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await confirmed.waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "View draft", exact: true }).click();
    await page.getByRole("button", { name: "Open poll", exact: true }).click();
    await confirmed.waitFor({ timeout: 60_000 });
    await page.getByRole("radio", { name: "Wallet", exact: true }).check();
    await page
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    await confirmed.waitFor({ timeout: 60_000 });
    await page
      .getByText("Your answer is confirmed and cannot change.")
      .waitFor();
    assert.equal(
      await page
        .getByRole("radio", { name: "Explorer", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("combobox", { name: "Wallet account" })
      .selectOption(accounts[1]!.address);
    await page.getByRole("radio", { name: "Explorer", exact: true }).check();
    await page
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    await confirmed.waitFor({ timeout: 60_000 });
    await page.getByText("2 participants", { exact: true }).waitFor();
    await page
      .getByRole("navigation", { name: "Questions", exact: true })
      .getByRole("button", { name: "2", exact: true })
      .click();
    await page.getByRole("radio", { name: "Friday", exact: true }).check();
    await page
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    await confirmed.waitFor({ timeout: 60_000 });
    await page
      .getByRole("combobox", { name: "Wallet account" })
      .selectOption(accounts[0]!.address);
    await page.getByRole("button", { name: "Close poll", exact: true }).click();
    await confirmed.waitFor({ timeout: 60_000 });
    await page
      .getByText("This poll is closed. The results are final.")
      .waitFor();
    await page.reload();
    await page
      .getByText("This poll is closed. The results are final.")
      .waitFor();
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `Overflow at ${width}`,
        );
        await page.screenshot({
          path: join(evidence, `${colorScheme}-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page.screenshot({
      path: join(evidence, "desktop.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      `Voting browser checks passed (${signatures} wallet signatures).`,
    );
  } catch (error) {
    console.error(
      "Visible alerts:",
      await page.getByRole("alert").allTextContents(),
    );
    await page.screenshot({
      path: join(evidence, "failure.png"),
      fullPage: true,
    });
    throw error;
  }
}

async function checkContract(client: Client, address: ContractAddress) {
  const config = { address, networkId: toBase58(client.network.networkHash) };
  async function participant() {
    const account = createPubkeyAccount({
      signer: new Ed25519Signer(randomBytes(32)),
    });
    const wallet = createWalletClient({ client, account });
    assert.equal((await wallet.requestAirdrop()).attemptStatus, "succeeded");
    return wallet;
  }
  const admin = await participant();
  const voter = await participant();
  let height = 0n;
  async function send(wallet: typeof admin, invocation: Invocation) {
    const result = await wallet.executeAndWait(
      { invocation, gasLimit: GAS },
      { timeoutMs: 60_000 },
    );
    height = result.receipt.blockHeight;
    console.log(`Confirmed: ${toBase58(result.transactionHash)}`);
    return result;
  }
  async function rejects(wallet: typeof admin, invocation: Invocation) {
    await assert.rejects(
      () => send(wallet, invocation),
      TransactionExecutionError,
    );
  }

  const definition: Definition = {
    title: "Community priorities",
    description: "Localnode integration test",
    questions: [
      { title: "What should we build?", options: ["Wallet", "Explorer"] },
      { title: "When should we meet?", options: ["Monday", "Friday"] },
    ],
  };
  await send(
    admin,
    methods.createPoll.invocation(address, GAS, { definition }),
  );
  await send(
    admin,
    methods.editPoll.invocation(address, GAS, {
      id: 0n,
      definition: { ...definition, title: "Community priorities — reviewed" },
    }),
  );
  await rejects(voter, methods.openPoll.invocation(address, GAS, { id: 0n }));
  await rejects(
    voter,
    methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 0n }),
  );
  await send(admin, methods.openPoll.invocation(address, GAS, { id: 0n }));
  await send(
    admin,
    methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 0n }),
  );
  await send(
    voter,
    methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 1n }),
  );
  await rejects(
    voter,
    methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 0n }),
  );
  await send(
    voter,
    methods.vote.invocation(address, GAS, { id: 0n, question: 1n, option: 0n }),
  );
  await send(admin, methods.closePoll.invocation(address, GAS, { id: 0n }));
  await rejects(admin, methods.openPoll.invocation(address, GAS, { id: 0n }));
  await rejects(
    admin,
    methods.vote.invocation(address, GAS, { id: 0n, question: 1n, option: 0n }),
  );
  const poll = await methods.getPoll.view({
    client,
    address,
    args: { id: 0n },
    minStateBlockHeight: height,
  });
  assert.equal(poll.value.status, 2n);
  const state = await readPoll(
    client,
    config,
    0n,
    toBase58(voter.account.address),
  );
  assert.equal(state.participants, 2n);
  assert.deepEqual(state.totals, [
    [1n, 1n],
    [1n, 0n],
  ]);
  assert.deepEqual(state.answers, [1n, 0n]);
  assert.equal((await listPolls(client, config, 0)).polls.length, 1);

  // Exercise maximum ABI sizes in the real RV32 guest, not only native Rust.
  const maximum: Definition = {
    title: "T".repeat(160),
    description: "D".repeat(512),
    questions: Array.from({ length: 8 }, () => ({
      title: "Q".repeat(160),
      options: Array.from({ length: 6 }, (_, i) => `${i}${"O".repeat(95)}`),
    })),
  };
  await send(
    admin,
    methods.createPoll.invocation(address, GAS, { definition: maximum }),
  );
  await send(admin, methods.openPoll.invocation(address, GAS, { id: 1n }));
  await send(
    voter,
    methods.vote.invocation(address, GAS, { id: 1n, question: 7n, option: 5n }),
  );
  const maxState = await readPoll(
    client,
    config,
    1n,
    toBase58(voter.account.address),
  );
  assert.equal(maxState.totals[7]?.[5], 1n);
  console.log(`Voting contract checks passed. Contract: ${toBase58(address)}`);
}
