import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
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
  TransactionExecutionError,
} from "@thruputchain/client";
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  parseProviderRequest,
  parseSignedTransactionHex,
  parseTransactionHex,
} from "@thruputchain/client/provider";
import { gasAmount, networkHash, sha256Hash } from "@thruputchain/protocol";
import { ERC20 } from "@thruputchain/client/contracts";
import { setup } from "../../apps/airdrop/scripts/index";
import { setup as setupLaunchpad } from "../../apps/token-launchpad/scripts/index";
import { setup as setupSwap } from "../../apps/swap/scripts/index";
import { Airdrop } from "../../apps/airdrop/src/contracts/generated/airdrop";
import { OwnedProcessGroups } from "./helpers/process-groups.mjs";
import { waitForView } from "../../examples/typescript/wait-for-view";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-airdrop-"));
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
  if (errors.length) throw new AggregateError(errors, "Airdrop cleanup failed");
}
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  void cleanup().catch(console.error);
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const watchdog = setTimeout(interrupt, 300_000);
try {
  const rpcUrl = await startNode();
  const env = {
    THRUPUT_RPC_URL: rpcUrl,
    LAUNCHPAD_APP_ENV: join(work, "launchpad.env"),
    LAUNCHPAD_APP_PUBLIC_DIR: join(work, "launchpad-public"),
    SWAP_APP_ENV: join(work, "swap.env"),
    SWAP_APP_PUBLIC_DIR: join(work, "swap-public"),
    AIRDROP_ENV_PATH: join(work, "airdrop.env"),
    AIRDROP_PACKS: "3",
  };
  await setupLaunchpad(env);
  await setupSwap(env);
  const deployment = await setup(env);
  assert.equal(
    toBase58(deployment.client.network.networkHash),
    toBase58(new Uint8Array(32).fill(1)),
  );
  await checkContract(deployment);
  await checkBrowser(deployment);
  await checkExistingTokens(deployment, env);
  const before = await readFile(deployment.output, "utf8");
  await assert.rejects(() => setup(env), /already exists/);
  assert.equal(await readFile(deployment.output, "utf8"), before);
  console.log(`Airdrop end-to-end checks passed. Evidence: ${work}`);
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await cleanup();
}

type Deployment = Awaited<ReturnType<typeof setup>>;
async function checkContract(
  { client, address, tokens }: Deployment,
  account = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(randomBytes(32)),
  }),
) {
  const wallet = createWalletClient({ client, account });
  await wallet.requestAirdrop();
  const options = { client, address, args: { address: account.address } };
  assert.equal((await Airdrop.v0_1.eligible.view(options)).value, true);
  const request = {
    invocation: Airdrop.v0_1.claim.invocation(address, gasAmount(20_000_000n)),
    gasLimit: gasAmount(20_000_000n),
  };
  const result = await wallet.executeAndWait(request, { timeoutMs: 60_000 });
  assert.equal(
    (
      await waitForView(() =>
        Airdrop.v0_1.hasClaimed.view({
          ...options,
          minStateBlockHeight: result.receipt.blockHeight,
        }),
      )
    ).value,
    true,
  );
  for (const token of tokens) {
    const balance = await waitForView(() =>
      ERC20.v0_1.getBalanceOf.view({
        client,
        address: addressFromBase58(token.address),
        args: { addr: account.address },
        minStateBlockHeight: result.receipt.blockHeight,
      }),
    );
    assert.equal(balance.value, BigInt(token.claimAmount));
  }
  await assert.rejects(
    () => wallet.executeAndWait(request, { timeoutMs: 60_000 }),
    TransactionExecutionError,
  );
}

async function checkExistingTokens(
  deployment: Deployment,
  env: Record<string, string>,
) {
  const tokensFile = join(work, "existing-tokens.json");
  const addressesFile = join(work, "eligible.json");
  const eligible = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(randomBytes(32)),
  });
  await writeFile(tokensFile, JSON.stringify(deployment.tokens.slice(0, 1)));
  await writeFile(addressesFile, JSON.stringify([toBase58(eligible.address)]));
  const key = JSON.parse(
    await readFile(join(deployment.directory, "key.json"), "utf8"),
  );
  const customEnv = {
    ...env,
    AIRDROP_ENV_PATH: join(work, "restricted.env"),
    AIRDROP_TOKENS_FILE: tokensFile,
    AIRDROP_ADDRESSES_FILE: addressesFile,
    AIRDROP_DEPLOYER_PRIVATE_KEY: key.seed as string,
    AIRDROP_PACKS: "2",
  };
  // Devnet defaults with an existing-token owner, against this isolated local node.
  const restricted = await setup(customEnv, "devnet");
  const stranger = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(randomBytes(32)),
  });
  const wallet = createWalletClient({
    client: deployment.client,
    account: stranger,
  });
  await wallet.requestAirdrop();
  await assert.rejects(
    () =>
      wallet.executeAndWait(
        {
          invocation: Airdrop.v0_1.claim.invocation(
            restricted.address,
            gasAmount(20_000_000n),
          ),
          gasLimit: gasAmount(20_000_000n),
        },
        { timeoutMs: 60_000 },
      ),
    TransactionExecutionError,
  );
  await checkContract(restricted, eligible);
  const mismatchEnv = {
    ...customEnv,
    AIRDROP_ENV_PATH: join(work, "rejected.env"),
  };
  await assert.rejects(
    () =>
      setup({
        ...mismatchEnv,
        THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)),
      }),
    /network/i,
  );
  await writeFile(
    tokensFile,
    JSON.stringify([{ ...deployment.tokens[0], symbol: "WRONG" }]),
  );
  await assert.rejects(
    () => setup(mismatchEnv),
    /metadata or deployer balance/,
  );
  await assert.rejects(() => readFile(mismatchEnv.AIRDROP_ENV_PATH), {
    code: "ENOENT",
  });
}

async function checkBrowser({ client, output }: Deployment) {
  assert.ok(!interrupted, "Airdrop checks interrupted");

  const env = parseEnv(await readFile(output, "utf8"));
  Object.assign(process.env, env);
  process.env.AIRDROP_ENV_PATH = output;
  const signer = new Ed25519Signer(randomBytes(32));
  const account = createPubkeyAccount({ signer });
  await createWalletClient({ client, account }).requestAirdrop();
  const accounts = [
    {
      address: toBase58(account.address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    },
  ];
  const network = toBase58(client.network.networkHash);
  server = await createServer({
    root: join(root, "apps/airdrop"),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const socket = server.httpServer!.address();
  assert(socket && typeof socket !== "string");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  let signatures = 0;
  let failedSubmission: string | null = null;
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction(
      "airdropWalletRequest",
      async (input: unknown) => {
        const request = parseProviderRequest(input);
        if (request.method === "signTransaction") {
          assert.equal(request.params.account, accounts[0]!.address);
          assert.equal(request.params.networkHash, network);
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
          if (failedSubmission === null) {
            failedSubmission = request.params.signedTransaction;
            throw new Error("Test connection failure before broadcast");
          }
          assert.equal(request.params.signedTransaction, failedSubmission);
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
        }
        throw new Error("Unexpected wallet request");
      },
    );
    await page.addInitScript({
      content: `(() => {
    const accounts = ${JSON.stringify(accounts)}, networkHash = ${JSON.stringify(network)};
    let session = { networkHash, accounts: [] }; const listeners = new Set();
    const change = next => { session = next; listeners.forEach(f => f(session)); };
    const provider = { info: { id: "airdrop-test", name: "Airdrop test wallet", version: "2.0.0" },
      on(event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async request(request) {
        if (request.method === "connect") { change({ networkHash, accounts }); return session; }
        if (request.method === "getSession") return session;
        if (request.method === "disconnect") { change({ networkHash, accounts: [] }); return null; }
        if (request.method === "getCapabilities") throw { code: 4200, message: "No batching" };
        return window.airdropWalletRequest(request);
      }
    };
    const announce = () => window.dispatchEvent(new CustomEvent(${JSON.stringify(ANNOUNCE_PROVIDER_EVENT)}, { detail: provider }));
    window.addEventListener(${JSON.stringify(REQUEST_PROVIDER_EVENT)}, announce); announce();
  })();`,
    });
    await page.goto(`http://127.0.0.1:${socket.port}`);
    await page.getByRole("heading", { name: "Claim your airdrop" }).waitFor();
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Claim airdrop", exact: true })
      .click();
    await page
      .getByRole("alert")
      .first()
      .waitFor({ timeout: 60000 })
      .catch(async (error) => {
        console.error(await page.locator("main").innerText(), {
          signatures,
          failedSubmission: !!failedSubmission,
        });
        throw error;
      });
    assert(failedSubmission, "The first submission must fail before broadcast");
    await page.reload();
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retry saved transaction", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Airdrop claimed", exact: true })
      .waitFor({ timeout: 60000 })
      .catch(async (error) => {
        console.error(await page.locator("main").innerText());
        throw error;
      });
    assert.equal(signatures, 1);
    await page.reload();
    await page
      .getByRole("heading", { name: "Airdrop claimed", exact: true })
      .waitFor({ timeout: 60000 });
    assert.equal(signatures, 1, "Reload must not sign another claim");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      assert.equal(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--signal")
            .trim(),
        ),
        "#fdda24",
      );
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        ),
        colorScheme === "light" ? "rgb(245, 245, 240)" : "rgb(10, 10, 10)",
      );
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await mkdir(join(work, "screenshots"), { recursive: true });
        await page.screenshot({
          path: join(work, "screenshots", `${colorScheme}-${width}.png`),
          fullPage: true,
        });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      "Wallet claim, reload recovery, Thruput light/dark colors, and responsive layouts passed.",
    );
  } finally {
    await browser.close();
    await server.close();
  }
}

async function startNode(): Promise<string> {
  const child = groups.spawn(
    process.env.THRUPUT_CLI ?? "thruput",
    [
      "node",
      "--json",
      "--port",
      "0",
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
  let stdout = "",
    stderr = "";
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
    assert.ok(!interrupted, "Airdrop checks interrupted");
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Node stopped: ${stderr}`);
    assert.equal(child.signalCode, null, `Node stopped: ${stderr}`);
    let startup: { data?: { rpcUrl?: string } } | undefined;
    try {
      startup = JSON.parse(stdout);
    } catch {
      /* Wait for complete startup JSON. */
    }
    if (startup?.data?.rpcUrl) return startup.data.rpcUrl;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Node startup timed out: ${stderr}`);
}
