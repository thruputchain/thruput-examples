// @vitest-environment node
/// <reference types="node" />

import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGroundhogClient,
  HttpTransport,
  localnet,
  toHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import { describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "@/config";
import { readCreatedTokens, reviewFactory } from "@/contracts/launchpad-client";
import { parseDevelopmentPersonas } from "@/development-personas";
import { runWorkflow } from "@/launch/executor";
import type { ParsedToken } from "@/launch/form";
import {
  createWorkflow,
  saveWorkflow,
  workflowIntent,
  workflowStorageKey,
  type LaunchWorkflow,
} from "@/launch/workflow";
import { createLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { GroundhogRegistrySource } from "../../server/chain";
import type { RegistryScope } from "../../server/domain";
import { createRegistryHttpServer } from "../../server/http";
import { RegistryIndexer } from "../../server/indexer";
import { RegistryStore } from "../../server/store";

const runCleanLedger =
  import.meta.env.MODE === "local-integration" &&
  process.env.RUN_TOKEN_LAUNCHPAD_CLEAN_LEDGER_E2E === "1";

const locks = {
  request: async (_name: string, callback: (lock: Lock) => unknown) =>
    callback({ name: "launchpad-e2e", mode: "exclusive" }),
} as unknown as LockManager;

describe
  .skipIf(!runCleanLedger)
  .sequential("clean-ledger token launchpad acceptance", () => {
    it("launches and discovers distinct tokens for Alice and Bob", async () => {
      installNodeWindow();
      window.localStorage.clear();
      const base = localConfig();
      const client = await createGroundhogClient({
        cluster: localnet({ rpcUrl: base.rpcUrl.href }),
        transport: new HttpTransport(base.rpcUrl.href, { timeoutMs: 10_000 }),
      });
      const personas = parseDevelopmentPersonas(
        import.meta.env.GROUNDHOG_DEV_PERSONAS,
      );
      expect(personas).not.toBeNull();
      if (personas === null) return;
      const alice = personas.find(({ id }) => id === "alice")!;
      const bob = personas.find(({ id }) => id === "bob")!;
      const token: ParsedToken = {
        name: "Clean Ledger Token",
        symbol: "CLT",
        decimals: 7,
        initialSupply: 1_000_000_000_000n,
      };
      const bobToken: ParsedToken = {
        ...token,
        name: "Second Registry Token",
        symbol: "BOB",
      };

      const aliceConfig = { ...base, accountAddress: alice.accountAddress };
      const bobConfig = { ...base, accountAddress: bob.accountAddress };
      const aliceLaunch = await launch({
        client,
        config: aliceConfig,
        privateKeyHex: alice.privateKeyHex,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        token,
      });
      const bobLaunch = await launch({
        client,
        config: bobConfig,
        privateKeyHex: bob.privateKeyHex,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        token: bobToken,
      });

      expect(aliceLaunch.createdAddressHex).not.toBe(
        bobLaunch.createdAddressHex,
      );
      const aliceTokens = await eventuallyDiscover(client, aliceConfig, [
        aliceLaunch.createdAddressHex,
      ]);
      const bobTokens = await eventuallyDiscover(client, bobConfig, [
        bobLaunch.createdAddressHex,
      ]);
      const allTokens = await eventuallyDiscover(
        client,
        aliceConfig,
        [aliceLaunch.createdAddressHex, bobLaunch.createdAddressHex],
        null,
      );
      expect(
        aliceTokens.some(
          ({ addressHex }) => addressHex === bobLaunch.createdAddressHex,
        ),
      ).toBe(false);
      expect(
        bobTokens.some(
          ({ addressHex }) => addressHex === aliceLaunch.createdAddressHex,
        ),
      ).toBe(false);
      expect(
        aliceTokens.find(
          ({ addressHex }) => addressHex === aliceLaunch.createdAddressHex,
        ),
      ).toMatchObject({
        addressHex: aliceLaunch.createdAddressHex,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        initialSupply: token.initialSupply,
        balance: token.initialSupply,
        administratorHex: toHex0x(alice.accountAddress),
        holderHex: toHex0x(alice.accountAddress),
        readError: false,
      });
      expect(
        bobTokens.find(
          ({ addressHex }) => addressHex === bobLaunch.createdAddressHex,
        ),
      ).toMatchObject({
        addressHex: bobLaunch.createdAddressHex,
        name: bobToken.name,
        symbol: bobToken.symbol,
        decimals: bobToken.decimals,
        initialSupply: bobToken.initialSupply,
        balance: bobToken.initialSupply,
        administratorHex: toHex0x(bob.accountAddress),
        holderHex: toHex0x(bob.accountAddress),
        readError: false,
      });
      expect(allTokens.map(({ addressHex }) => addressHex)).toEqual(
        expect.arrayContaining([
          aliceLaunch.createdAddressHex,
          bobLaunch.createdAddressHex,
        ]),
      );

      await verifyPersistentRegistry({
        client,
        config: base,
        aliceAddress: toHex0x(alice.accountAddress),
        bobAddress: toHex0x(bob.accountAddress),
        aliceToken: aliceLaunch.createdAddressHex,
        bobToken: bobLaunch.createdAddressHex,
      });
    }, 180_000);
  });

async function launch(input: {
  client: GroundhogClient;
  config: AppConfig;
  privateKeyHex: string;
  nonce: Uint8Array;
  token: ParsedToken;
}): Promise<LaunchWorkflow & { createdAddressHex: string }> {
  const review = await reviewFactory(input.client, input.config, input.nonce);
  expect(review.fundingShortfall).toBe(0n);
  expect(review.fundingAmount).toBeGreaterThan(0n);
  let workflow = createWorkflow(input.config, input.token, input.nonce, review);
  saveWorkflow(window.localStorage, workflowStorageKey(input.config), workflow);
  const writer = createLocalWriteBoundary(
    input.config,
    {
      privateKeyHex: input.privateKeyHex,
      walletEntrypointHex: required(
        import.meta.env.VITE_GROUNDHOG_WALLET_ENTRYPOINT,
      ),
    },
    { client: input.client },
  );
  workflow = await runWorkflow({
    config: input.config,
    client: input.client,
    writer,
    automatic: true,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    expectedIntent: workflowIntent(workflow),
    locks,
  });
  expect(workflow.funding.status).toBe("committed");
  expect(workflow.creation.status).toBe("committed");
  expect(workflow.verification.status).toBe("complete");
  expect(workflow.createdAddressHex).toBe(workflow.predictedAddressHex);
  expect(workflow.verification.totalSupply).toBe(
    input.token.initialSupply.toString(),
  );
  expect(workflow.verification.holderBalance).toBe(
    input.token.initialSupply.toString(),
  );
  if (workflow.createdAddressHex === null) {
    throw new Error("Committed launch is missing its created address");
  }
  return { ...workflow, createdAddressHex: workflow.createdAddressHex };
}

async function eventuallyDiscover(
  client: GroundhogClient,
  config: AppConfig,
  expectedAddresses: string[],
  creator: AppConfig["accountAddress"] | null = config.accountAddress,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await readCreatedTokens(client, config, { creator });
    const addresses = new Set(
      result.tokens.map(({ addressHex }) => addressHex),
    );
    if (expectedAddresses.every((address) => addresses.has(address))) {
      return result.tokens;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Token events were not indexed before the acceptance timeout",
  );
}

function localConfig(): AppConfig {
  return loadConfig({
    VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
    VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
    VITE_GROUNDHOG_WALLET_ADDRESS: import.meta.env
      .VITE_GROUNDHOG_WALLET_ADDRESS,
    VITE_STANDARD_TOKEN_FACTORY_ADDRESS: import.meta.env
      .VITE_STANDARD_TOKEN_FACTORY_ADDRESS,
    VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
    VITE_NATIVE_BALANCE_ITEM_COST: import.meta.env
      .VITE_NATIVE_BALANCE_ITEM_COST,
    VITE_STANDARD_TOKEN_HASH: import.meta.env.VITE_STANDARD_TOKEN_HASH,
  });
}

function required(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error("Local launchpad setup is incomplete");
  }
  return value;
}

async function verifyPersistentRegistry(input: {
  client: GroundhogClient;
  config: AppConfig;
  aliceAddress: string;
  bobAddress: string;
  aliceToken: string;
  bobToken: string;
}): Promise<void> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "launchpad-registry-e2e-"),
  );
  const databasePath = path.join(directory, "registry.sqlite");
  const scope: RegistryScope = {
    networkId: input.config.networkIdHex,
    factoryAddress: toHex0x(input.config.factoryAddress),
    tokenCodeHash: toHex0x(input.config.expectedTokenHash),
  };
  let store: RegistryStore | null = null;
  let server: Server | null = null;
  try {
    const source = new GroundhogRegistrySource(input.client, scope);
    await source.verifyScope();
    store = new RegistryStore(databasePath, scope);
    const indexer = new RegistryIndexer(store, source, {
      pageSize: 1,
      syncIntervalMs: 60_000,
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await indexer.sync();
      if (store.getStatus().tokenCount >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(store.getStatus()).toMatchObject({
      tokenCount: 2,
      historyLimited: false,
    });

    server = createRegistryHttpServer(store, indexer);
    const origin = await listen(server);
    const global = await registryQuery(origin, "sort=oldest");
    expect(global.total).toBe(2);
    expect(global.tokens.map(({ tokenAddress }) => tokenAddress)).toEqual([
      input.aliceToken,
      input.bobToken,
    ]);
    const search = await registryQuery(origin, "q=bob");
    expect(search.tokens.map(({ tokenAddress }) => tokenAddress)).toEqual([
      input.bobToken,
    ]);
    const creator = await registryQuery(
      origin,
      `creator=${encodeURIComponent(input.aliceAddress)}`,
    );
    expect(creator.tokens.map(({ creatorAddress }) => creatorAddress)).toEqual([
      input.aliceAddress,
    ]);
    const bobCreator = await registryQuery(
      origin,
      `creator=${encodeURIComponent(input.bobAddress)}`,
    );
    expect(
      bobCreator.tokens.map(({ creatorAddress }) => creatorAddress),
    ).toEqual([input.bobAddress]);
    const firstPage = await registryQuery(origin, "sort=name&limit=1");
    const secondPage = await registryQuery(
      origin,
      `sort=name&limit=1&offset=1&asOfBlock=${firstPage.asOfBlock}`,
    );
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.hasMore).toBe(false);
    expect(
      new Set([
        firstPage.tokens[0]?.tokenAddress,
        secondPage.tokens[0]?.tokenAddress,
      ]),
    ).toEqual(new Set([input.aliceToken, input.bobToken]));

    await indexer.stop();
    await close(server);
    server = null;
    store.close();
    store = null;

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.getStatus().tokenCount).toBe(2);
    expect(
      reopened.queryTokens({ sort: "newest", limit: 20, offset: 0 }).tokens,
    ).toHaveLength(2);
    reopened.close();
  } finally {
    if (server !== null) await close(server);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

interface RegistryResponse {
  tokens: Array<{ tokenAddress: string; creatorAddress: string }>;
  total: number;
  asOfBlock: string;
  hasMore: boolean;
}

async function registryQuery(
  origin: string,
  query: string,
): Promise<RegistryResponse> {
  const response = await fetch(`${origin}/api/tokens?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RegistryResponse;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Registry acceptance server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function installNodeWindow(): void {
  if (typeof window !== "undefined") return;
  const values = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage, setTimeout: globalThis.setTimeout },
  });
}
