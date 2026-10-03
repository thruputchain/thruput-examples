import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import {
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  localnet,
  PrivateKeySigner,
  prepareContractDeployment,
  gasAmount,
  toHex0x,
  signTransaction,
  hashSignedTransaction,
} from "@groundhogchain/client";
import { ERC20 } from "@groundhogchain/client/contracts";
import {
  parseProviderRequest,
  parseTransactionHex,
  parseSignedTransactionHex,
} from "@groundhogchain/client/provider";
import { HOG_ADDRESS, codec, serialize } from "@groundhogchain/protocol";
import { Counter } from "../../apps/counter/src/contracts/generated/counter.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
await mkdir(join(root, ".local"), { recursive: true });
const work = await mkdtemp(join(root, ".local/counter-wallet-"));
const tutorial = process.env.COUNTER_GUIDE_ROOT;
const cli = process.env.GROUNDHOG_CLI || "groundhog";
const node = spawn(
  cli,
  ["node", "--port", "0", "--json", "--non-interactive"],
  {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: work,
      XDG_CONFIG_HOME: join(work, "config"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const exit = once(node, "exit");
const lines = createInterface({ input: node.stdout });
const watchdog = setTimeout(() => node.kill("SIGTERM"), 120_000);
let server: ViteDevServer | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let api: ReturnType<typeof spawn> | undefined;
try {
  const ready = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line)),
    exit.then(([code]) => {
      throw new Error(`Node exited before readiness: ${code}`);
    }),
  ]);
  assert.equal(ready.ok, true);
  const client = await createGroundhogClient({
    cluster: localnet({ rpcUrl: ready.data.rpc_url }),
  });
  const key = randomBytes(32);
  const signer = new PrivateKeySigner(key);
  const account = createPubkeyAccount({ signer });
  const wallet = createWalletClient({ client, account });
  const funded = await wallet.requestAirdrop();
  assert.equal(funded.status.result, "ok");
  const plan = prepareContractDeployment({
    deployer: account.address,
    contract: await readFile(join(root, "target/groundhog/counter.rv32a")),
  });
  await wallet.executeAndWait({
    invocation: ERC20.v0_1.transfer.invocation(
      HOG_ADDRESS,
      gasAmount(500_000n),
      { receiver: plan.address, amount: 10_000_000n },
    ),
    gasLimit: gasAmount(2_000_000n),
  });
  await wallet.deployContractAndWait(plan, gasAmount(10_000_000n));
  await wallet.executeAndWait({
    invocation: Counter.v0_1.initialize.invocation(
      plan.address,
      gasAmount(500_000n),
      { initialValue: 10n },
    ),
    gasLimit: gasAmount(1_000_000n),
  });

  const publicEnv = {
    VITE_GROUNDHOG_RPC_URL: ready.data.rpc_url,
    VITE_GROUNDHOG_NETWORK_ID: toHex0x(client.network.networkHash),
    VITE_COUNTER_ADDRESS: toHex0x(plan.address),
    COUNTER_SIGNING_PRIVATE_KEY: toHex0x(key),
  };
  if (tutorial) {
    api = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: tutorial,
      env: { ...process.env, COUNTER_SIGNING_PRIVATE_KEY: toHex0x(key), RPC_URL: ready.data.rpc_url, NETWORK_HASH: publicEnv.VITE_GROUNDHOG_NETWORK_ID, COUNTER_ADDRESS: publicEnv.VITE_COUNTER_ADDRESS },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await Promise.race([once(api.stdout!, "data"), once(api, "exit").then(([code]) => { throw new Error(`Tutorial API exited: ${code}`); })]);
  }
  Object.assign(process.env, publicEnv);
  const appRoot = tutorial || join(root, "apps/counter");
  server = await createServer({
    root: appRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let developmentRequests = 0;
  page.on("request", request => { if (request.url().endsWith("/api/prepare")) developmentRequests++; });
  await page.goto(server.resolvedUrls!.local[0]!);
  const counterValue = () => tutorial ? page.getByLabel("Counter value", { exact: true }) : page.getByTestId("counter-value");
  const committedText = tutorial ? "Update committed" : "Counter update committed.";
  await counterValue().filter({ hasText: "10" }).waitFor();
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await counterValue().filter({ hasText: "11" }).waitFor();
  if (tutorial) { await page.getByText(committedText, { exact: true }).waitFor(); await page.getByRole("button", { name: "Finish", exact: true }).click(); }
  assert.equal(developmentRequests, 1);

  // Use a different funded account so the two signing paths are distinguishable.
  const walletSigner = new PrivateKeySigner(randomBytes(32));
  const walletAccount = createPubkeyAccount({ signer: walletSigner });
  await wallet.executeAndWait({ invocation: ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gasAmount(500_000n), { receiver: walletAccount.address, amount: 20_000_000n }), gasLimit: gasAmount(2_000_000n) });
  const network = toHex0x(client.network.networkHash).slice(2);
  const accountWire = {
    address: toHex0x(walletAccount.address),
    publicKey: toHex0x(walletSigner.publicKey.ed25519),
    nonce: "0",
  };
  await page.exposeFunction("guideRequest", async (value: unknown) => {
    const request = parseProviderRequest(value);
    if (request.method === "signTransaction") {
      const signed = await signTransaction(
        parseTransactionHex(request.params.transaction),
        [{ signer: walletSigner, publicKeyId: 0n }],
        client.network.networkHash,
      );
      return {
        signedTransaction: toHex0x(serialize(signed, codec.SignedTransaction)),
        hash: toHex0x(hashSignedTransaction(signed)),
      };
    }
    if (request.method === "submitTransaction")
      return {
        hash: toHex0x(
          await client.sendTransaction(
            parseSignedTransactionHex(request.params.signedTransaction),
          ),
        ),
      };
    throw new Error("Unexpected bridge request");
  });
  await page.addInitScript({
    content: `(() => {
    const network = ${JSON.stringify(network)};
    const accountWire = ${JSON.stringify(accountWire)};
    let session = { networkHash: network, accounts: [] };
    const listeners = new Set();
    const provider = {
      info: { id: "guide-live-test", name: "Guide live test wallet", version: "1.0.0" },
      on(_event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async request(request) {
        if (request.method === "signTransaction" && window.guideReject) throw { code: 4001, message: "Test wallet rejected the update" };
        if (request.method === "connect" || request.method === "disconnect") {
          session = { networkHash: network, accounts: request.method === "connect" ? [accountWire] : [] };
          listeners.forEach(listener => listener(session));
          return request.method === "connect" ? session : null;
        }
        if (request.method === "getSession") return session;
        return window.guideRequest(request);
      },
    };
    window.guideWrongNetwork = () => {
      session = { networkHash: "11".repeat(32), accounts: [accountWire] };
      listeners.forEach(listener => listener(session));
    };
    const announce = () => window.dispatchEvent(new CustomEvent("groundhog:announceProvider", { detail: provider }));
    window.addEventListener("groundhog:requestProvider", announce);
    announce();
  })();`,
  });
  await page.goto(server.resolvedUrls!.local[0]!);
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByText(/Using connected wallet/).waitFor();
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await page
    .getByText(committedText, { exact: true })
    .waitFor({ timeout: 30_000 });
  await counterValue().filter({ hasText: "12" }).waitFor();
  assert.equal(developmentRequests, 1, "Wallet mode must not use the development signing endpoint");
  await page.reload();
  await page.getByText(committedText, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByText(/Using connected wallet/).waitFor();
  await page.evaluate("window.guideReject = true");
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await page.getByText("Test wallet rejected the update", { exact: true }).waitFor();
  assert.equal(developmentRequests, 1, "Rejection must not fall back to development signing");
  await page.evaluate("window.guideWrongNetwork()");
  await page.getByRole("alert").filter({ hasText: /Select the app/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Increment", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
  await page.getByText(/Using development signer/).waitFor();
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await counterValue().filter({ hasText: "13" }).waitFor();
  assert.equal(developmentRequests, 2);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: join(work, `counter-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Counter passed: default development signing, wallet switch, rejection, network guard, explicit disconnect, reload recovery, desktop/mobile.",
  );
  console.log("Evidence:", work);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
  if (api && api.exitCode === null) { api.kill("SIGTERM"); await once(api, "exit"); }
  lines.close();
  node.kill("SIGTERM");
  await exit;
}
