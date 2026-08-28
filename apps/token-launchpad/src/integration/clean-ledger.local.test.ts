/// <reference types="node" />

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
import { advanceWorkflow } from "@/launch/executor";
import type { ParsedToken } from "@/launch/form";
import {
  createWorkflow,
  saveWorkflow,
  workflowIntent,
  workflowStorageKey,
  type LaunchWorkflow,
} from "@/launch/workflow";
import { createLocalWriteBoundary } from "@/transactions/local-development-wallet";

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
        token,
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
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        initialSupply: token.initialSupply,
        balance: token.initialSupply,
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
  workflow = await advanceWorkflow({
    config: input.config,
    client: input.client,
    writer,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    expectedIntent: workflowIntent(workflow),
    locks,
  });
  expect(workflow.funding.status).toBe("committed");
  expect(workflow.creation.status).toBe("idle");
  workflow = await advanceWorkflow({
    config: input.config,
    client: input.client,
    writer,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    expectedIntent: workflowIntent(workflow),
    locks,
  });
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
