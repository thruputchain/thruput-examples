/// <reference types="node" />
// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addressFromHex,
  toHex0x,
  type TransactionReceipt,
} from "@groundhogchain/client";
import { describe, expect, it } from "vitest";

import { loadGlobalConfig, type GlobalConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { buildProcessRequestsTarget } from "@/contracts/driver-target";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { RequestAccepted } from "@/contracts/generated/swap-driver";
import {
  BurnEvent,
  MintEvent,
  SwapEvent,
} from "@/contracts/generated/swap-handler";
import { buildExactInputSwapTarget } from "@/contracts/router-target";
import { parseDevelopmentPersonas } from "@/development-personas";
import { formatAmount } from "@/domain/amount";
import { orientReserves, orderTokens } from "@/domain/tokens";
import { createReadClient } from "@/groundhog/client";
import {
  deriveAddLiquidityQuote,
  deriveRemoveLiquidityQuote,
} from "@/pools/liquidity-model";
import { preparePoolCreation } from "@/pools/pool-creation";
import { readPoolDirectory } from "@/pools/pool-directory";
import { deriveSwapQuote } from "@/swap/model";
import { createSnapshotReader } from "@/swap/snapshot";
import { runLiquidityOperation } from "@/transactions/liquidity-executor";
import { runCreationWorkflow } from "@/transactions/creation-executor";
import {
  createCreationWorkflow,
  saveCreationWorkflow,
} from "@/transactions/creation-workflow";
import {
  createAddLiquidityOperation,
  createRemoveLiquidityOperation,
  saveLiquidityOperations,
} from "@/transactions/liquidity-operation";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { withOutstandingRequestLock } from "@/transactions/outstanding-request";
import {
  createRequestRecord,
  loadRequestCollection,
  saveRequestCollection,
} from "@/transactions/request-collection";
import {
  applyObservationBatch,
  observationsFromReceipt,
} from "@/transactions/request-observer";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { createWalletPortfolioReader } from "@/wallet/portfolio";
import { GroundhogRegistrySource } from "../../server/chain";
import type { RegistryPool, RegistryScope } from "../../server/domain";
import { createRegistryHttpServer } from "../../server/http";
import { RegistryIndexer } from "../../server/indexer";
import { RegistryStore } from "../../server/store";

const runCleanLedger =
  import.meta.env.MODE === "local-integration" &&
  process.env.RUN_CLEAN_LEDGER_E2E === "1";

describe.skipIf(!runCleanLedger)("clean-ledger AMM acceptance", () => {
  it("runs the seeded pool journey across Alice, Carol, and Bob", async () => {
    installNodeWindow();
    window.localStorage.clear();
    const baseConfig = loadLocalConfig();
    const personas = parseDevelopmentPersonas(
      import.meta.env.GROUNDHOG_DEV_PERSONAS,
    );
    expect(personas).not.toBeNull();
    if (personas === null) return;
    const [alice, bob, carol] = personas;

    const directory = await readPoolDirectory(
      forPersona(baseConfig, alice!.accountAddress),
    );
    expect(directory.invalidEntryCount).toBe(0);
    expect(directory.entries).toHaveLength(1);
    const aliceConfig = directory.entries[0]!.config;
    const bobConfig = forPersona(aliceConfig, bob!.accountAddress);
    const carolConfig = forPersona(aliceConfig, carol!.accountAddress);

    const aliceSnapshot = await createSnapshotReader(aliceConfig)();
    expect(aliceSnapshot.liquidityBalance).toBeGreaterThan(0n);
    expect((await createSnapshotReader(carolConfig)()).liquidityBalance).toBe(
      0n,
    );
    expect((await createSnapshotReader(bobConfig)()).liquidityBalance).toBe(0n);

    const alicePortfolio = await createWalletPortfolioReader(aliceConfig)();
    expect(alicePortfolio.tokens.map(({ symbol }) => symbol)).toEqual(
      expect.arrayContaining(["gEUR", "gJPY", "gUSD", "HOG"]),
    );
    expect(alicePortfolio.liquidityPositions).toHaveLength(1);
    expect(alicePortfolio.liquidityPositions[0]!.balance).toBeGreaterThan(0n);
    expect(
      (await createWalletPortfolioReader(bobConfig)()).liquidityPositions,
    ).toHaveLength(0);

    const carolReceipts: TransactionReceipt[] = [];
    const carolWriter = recordingBoundary(
      createBrowserLocalWriteBoundary(carolConfig, carol!.privateKeyHex),
      carolReceipts,
    );
    const readCarolSnapshot = createSnapshotReader(carolConfig);
    const beforeAdd = await readCarolSnapshot();
    const addQuote = deriveAddLiquidityQuote(beforeAdd, 0, "0.0001", 100n);
    expect(addQuote.ok).toBe(true);
    if (!addQuote.ok) return;
    const add = createAddLiquidityOperation(carolConfig, {
      amountsDesired: addQuote.amountsDesired,
      amountsMin: addQuote.amountsMin,
      estimatedLiquidity: addQuote.estimatedLiquidity,
      liquidityBalanceBefore: beforeAdd.liquidityBalance,
      reservesBefore: [beforeAdd.reserve0, beforeAdd.reserve1],
    });
    saveLiquidityOperations(carolConfig, [add]);
    const added = await withOutstandingRequestLock(carolConfig, () =>
      runLiquidityOperation(carolConfig, add, {
        writeBoundary: carolWriter,
        readSnapshot: readCarolSnapshot,
      }),
    );
    expect(added).toMatchObject({
      status: "executed",
      result: { recipientVerified: true },
    });
    expect(
      carolReceipts.flatMap((receipt) =>
        MintEvent.allFromReceipt(receipt, {
          contractAddress: carolConfig.handlerAddress,
        }),
      ),
    ).toHaveLength(1);
    if (added.kind !== "add" || added.result === null) return;

    const afterAdd = await readCarolSnapshot();
    const minted = BigInt(added.result.liquidityMinted);
    expect(minted).toBeGreaterThan(1n);
    expect(afterAdd.liquidityBalance).toBe(beforeAdd.liquidityBalance + minted);
    const removeQuote = deriveRemoveLiquidityQuote(
      afterAdd,
      formatAmount(minted / 2n, afterAdd.liquidityTokenDecimals),
      100n,
    );
    expect(removeQuote.ok).toBe(true);
    if (!removeQuote.ok) return;
    const remove = createRemoveLiquidityOperation(carolConfig, {
      liquidity: removeQuote.liquidity,
      amountsMin: removeQuote.amountsMin,
    });
    saveLiquidityOperations(carolConfig, [added, remove]);
    const removed = await withOutstandingRequestLock(carolConfig, () =>
      runLiquidityOperation(carolConfig, remove, {
        writeBoundary: carolWriter,
        readSnapshot: readCarolSnapshot,
      }),
    );
    expect(removed.status).toBe("executed");
    expect(
      carolReceipts.flatMap((receipt) =>
        BurnEvent.allFromReceipt(receipt, {
          contractAddress: carolConfig.handlerAddress,
        }),
      ),
    ).toHaveLength(1);
    if (removed.kind !== "remove" || removed.result === null) return;
    expect(BigInt(removed.result.amountsRedeemed[0])).toBeGreaterThan(0n);
    expect(BigInt(removed.result.amountsRedeemed[1])).toBeGreaterThan(0n);
    const afterRemove = await readCarolSnapshot();
    expect(afterRemove.liquidityBalance).toBeGreaterThan(0n);
    expect(afterRemove.liquidityBalance).toBeLessThan(
      afterAdd.liquidityBalance,
    );
    expect(afterRemove.tokenA.allowance).toBe(0n);
    expect(afterRemove.tokenB.allowance).toBe(0n);
    expect(afterRemove.liquidityAllowance).toBe(0n);

    const bobWriter = createBrowserLocalWriteBoundary(
      bobConfig,
      bob!.privateKeyHex,
    );
    const readBobSnapshot = createSnapshotReader(bobConfig);
    const beforeSwap = await readBobSnapshot();
    const preview = deriveSwapQuote(beforeSwap, "aToB", "0.001", 500n);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    if (preview.allowanceDifference !== 0n) {
      expect(
        (
          await bobWriter.execute(
            buildApprovalTarget(
              bobConfig.tokenAAddress,
              bobConfig.handlerAddress,
              preview.allowanceDifference,
            ),
          )
        ).kind,
      ).toBe("committedSuccess");
    }
    const approved = await readBobSnapshot();
    const quote = deriveSwapQuote(approved, "aToB", "0.001", 500n);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    const enqueue = await bobWriter.execute(
      buildExactInputSwapTarget(bobConfig.routerAddress, {
        amountIn: quote.amountIn,
        amountOutMin: quote.amountOutMin,
        tokenIn: bobConfig.tokenAAddress,
        tokenOut: bobConfig.tokenBAddress,
        recipient: bobConfig.accountAddress,
      }),
    );
    expect(enqueue.kind).toBe("committedSuccess");
    if (enqueue.kind !== "committedSuccess") return;
    const requestId = toHex0x(
      RequestAccepted.singleFromReceipt(enqueue.receipt, {
        contractAddress: bobConfig.driverAddress,
      }).topics.request_id,
    );
    const request = createRequestRecord({
      status: "queued",
      phase: "swap",
      intent: { amountIn: quote.amountIn, amountOutMin: quote.amountOutMin },
      transactionHash: enqueue.hash,
      receiptBlock: enqueue.receipt.height,
      requestId,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria: {
        handlerAddress: toHex0x(bobConfig.handlerAddress),
        driverAddress: toHex0x(bobConfig.driverAddress),
        sender: toHex0x(bobConfig.accountAddress),
        recipient: toHex0x(bobConfig.accountAddress),
        tokenIn: toHex0x(bobConfig.tokenAAddress),
        tokenOut: toHex0x(bobConfig.tokenBAddress),
      },
    });
    saveRequestCollection(bobConfig, [request]);
    const crank = await bobWriter.execute(
      buildProcessRequestsTarget(bobConfig.driverAddress),
    );
    expect(crank.kind).toBe("committedSuccess");
    if (crank.kind !== "committedSuccess") return;
    const swaps = SwapEvent.allFromReceipt(crank.receipt, {
      contractAddress: bobConfig.handlerAddress,
    });
    expect(swaps).toHaveLength(1);
    expect(toHex0x(swaps[0]!.topics.recipient)).toBe(
      toHex0x(bobConfig.accountAddress),
    );
    expect(
      swaps[0]!.fields.request_id === null
        ? null
        : toHex0x(swaps[0]!.fields.request_id),
    ).toBe(requestId);
    const observation = observationsFromReceipt(
      bobConfig,
      [request],
      crank.receipt,
    );
    saveRequestCollection(
      bobConfig,
      applyObservationBatch([request], [request], observation),
    );
    expect(loadRequestCollection(bobConfig)).toMatchObject([
      { status: "executed" },
    ]);

    const afterSwap = await readBobSnapshot();
    const inputIndex = orderTokens(
      bobConfig.tokenAAddress,
      bobConfig.tokenBAddress,
    ).inputIndex;
    const amountsIn = orientReserves(swaps[0]!.fields.amounts_in, inputIndex);
    const amountsOut = orientReserves(swaps[0]!.fields.amounts_out, inputIndex);
    const reservesBefore = orientReserves(
      [beforeSwap.reserve0, beforeSwap.reserve1],
      inputIndex,
    );
    const reservesAfter = orientReserves(
      [afterSwap.reserve0, afterSwap.reserve1],
      inputIndex,
    );
    expect(amountsIn.reserveIn).toBe(quote.amountIn);
    expect(amountsOut.reserveOut).toBeGreaterThanOrEqual(quote.amountOutMin);
    expect(afterSwap.tokenA.balance).toBe(
      beforeSwap.tokenA.balance - quote.amountIn,
    );
    expect(afterSwap.tokenB.balance).toBe(
      beforeSwap.tokenB.balance + amountsOut.reserveOut,
    );
    expect(afterSwap.tokenA.allowance).toBe(0n);
    expect(reservesAfter.reserveIn).toBe(
      reservesBefore.reserveIn + quote.amountIn,
    );
    expect(reservesAfter.reserveOut).toBe(
      reservesBefore.reserveOut - amountsOut.reserveOut,
    );
    expect(afterSwap.liquidityTotalSupply).toBe(
      afterRemove.liquidityTotalSupply,
    );

    const directoryBeforeCreation = await readPoolDirectory(bobConfig);
    expect(directoryBeforeCreation.entries).toHaveLength(1);
    expect(directoryBeforeCreation.entries[0]!.snapshot.reserve0).toBe(
      afterSwap.reserve0,
    );
    expect(directoryBeforeCreation.entries[0]!.snapshot.reserve1).toBe(
      afterSwap.reserve1,
    );

    const [tokenA, , tokenC] = baseConfig.knownTokenAddresses ?? [];
    expect(tokenA).toBeDefined();
    expect(tokenC).toBeDefined();
    if (tokenA === undefined || tokenC === undefined) return;
    const carolGlobal = forPersona(baseConfig, carol!.accountAddress);
    const creationReview = await preparePoolCreation(carolGlobal, {
      tokenA: toHex0x(tokenA),
      tokenB: toHex0x(tokenC),
      amountA: "0.002",
      amountB: "0.002",
    });
    const creation = saveCreationWorkflow(
      carolGlobal,
      createCreationWorkflow(carolGlobal, creationReview),
    );
    const created = await withOutstandingRequestLock(carolGlobal, () =>
      runCreationWorkflow(carolGlobal, creation, {
        writeBoundary: createBrowserLocalWriteBoundary(
          carolGlobal,
          carol!.privateKeyHex,
        ),
      }),
    );
    expect(created.status).toBe("executed");

    const twoPoolDirectory = await readPoolDirectory(bobConfig);
    expect(twoPoolDirectory.invalidEntryCount).toBe(0);
    expect(twoPoolDirectory.entries).toHaveLength(2);
    await verifyPersistentPoolRegistry(baseConfig);
  }, 180_000);
});

async function verifyPersistentPoolRegistry(
  config: GlobalConfig,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "swap-registry-e2e-"));
  const databasePath = path.join(directory, "registry.sqlite");
  const scope: RegistryScope = {
    networkId: config.networkIdHex,
    factoryAddress: toHex0x(config.factoryAddress),
  };
  const client = createReadClient(config);
  let store: RegistryStore | null = null;
  let indexer: RegistryIndexer | null = null;
  let server: Server | null = null;
  try {
    const source = new GroundhogRegistrySource(client, scope);
    await source.verifyNetworkIdentity(new AbortController().signal);
    store = new RegistryStore(databasePath, scope);
    indexer = new RegistryIndexer(store, source, {
      pageSize: 1,
      syncIntervalMs: 60_000,
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await indexer.sync();
      if (store.getStatus().poolCount >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(store.getStatus()).toMatchObject({
      poolCount: 2,
      historyLimited: false,
    });

    server = createRegistryHttpServer(store, indexer);
    const origin = await listen(server);
    const oldest = await registryQuery(origin, "sort=oldest");
    const newest = await registryQuery(origin, "sort=newest");
    // The prior liquidity and swap transactions produced no additional registry records.
    expect(oldest.total).toBe(2);
    expect(oldest.pools.map(({ pairCount }) => pairCount)).toEqual(["1", "2"]);
    expect(newest.pools.map(({ pairCount }) => pairCount)).toEqual(["2", "1"]);

    const expected = oldest.pools[1]!;
    const search = await registryQuery(
      origin,
      `q=${expected.handlerAddress.slice(-8)}`,
    );
    expect(search.pools.map(({ pairCount }) => pairCount)).toEqual(["2"]);
    const filtered = await registryQuery(
      origin,
      `token=${encodeURIComponent(expected.token1Address)}`,
    );
    expect(filtered.pools.map(({ pairCount }) => pairCount)).toEqual(["2"]);

    const firstPage = await registryQuery(origin, "sort=token0&limit=1");
    const secondPage = await registryQuery(
      origin,
      `sort=token0&limit=1&offset=1&asOfBlock=${firstPage.asOfBlock}`,
    );
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.hasMore).toBe(false);
    expect(
      new Set(
        [...firstPage.pools, ...secondPage.pools].map(
          ({ pairCount }) => pairCount,
        ),
      ),
    ).toEqual(new Set(["1", "2"]));

    const factory = createSwapFactoryReadAdapter({
      client,
      contract: config.factoryAddress,
      caller: config.accountAddress,
    });
    for (const pool of oldest.pools) {
      const token0 = addressFromHex(pool.token0Address);
      const token1 = addressFromHex(pool.token1Address);
      const [handler, addresses, pair] = await Promise.all([
        factory.getPair(token0, token1),
        factory.poolAddresses(token0, token1),
        factory.pairAt(BigInt(pool.pairCount) - 1n),
      ]);
      expect(handler.value === null ? null : toHex0x(handler.value)).toBe(
        pool.handlerAddress,
      );
      expect(addresses.value).toMatchObject({
        liquidityToken: addressFromHex(pool.liquidityTokenAddress),
        handler: addressFromHex(pool.handlerAddress),
        driver: addressFromHex(pool.driverAddress),
      });
      expect(pair.value?.map(toHex0x)).toEqual([
        pool.token0Address,
        pool.token1Address,
      ]);
    }

    await indexer.stop();
    indexer = null;
    await close(server);
    server = null;
    store.close();
    store = null;

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.getStatus().poolCount).toBe(2);
    expect(
      reopened.queryPools({ sort: "newest", limit: 20, offset: 0 }).pools,
    ).toEqual(newest.pools);
    reopened.close();
  } finally {
    await indexer?.stop();
    if (server !== null) await close(server);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

interface RegistryResponse {
  pools: RegistryPool[];
  total: number;
  asOfBlock: string;
  hasMore: boolean;
}

async function registryQuery(
  origin: string,
  query: string,
): Promise<RegistryResponse> {
  const response = await fetch(`${origin}/api/pools?${query}`);
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

function recordingBoundary(
  delegate: WriteBoundary,
  receipts: TransactionReceipt[],
): WriteBoundary {
  return {
    execute: async (target, options) => {
      const result = await delegate.execute(target, options);
      if (result.kind === "committedSuccess") receipts.push(result.receipt);
      return result;
    },
  };
}

function forPersona<T extends GlobalConfig>(
  config: T,
  accountAddress: GlobalConfig["accountAddress"],
): T {
  return { ...config, accountAddress };
}

function loadLocalConfig(): GlobalConfig {
  return loadGlobalConfig({
    VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
    VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
    VITE_GROUNDHOG_WALLET_ADDRESS: import.meta.env
      .VITE_GROUNDHOG_WALLET_ADDRESS,
    VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
    VITE_KNOWN_TOKEN_ADDRESSES: import.meta.env.VITE_KNOWN_TOKEN_ADDRESSES,
    VITE_SWAP_FACTORY_ADDRESS: import.meta.env.VITE_SWAP_FACTORY_ADDRESS,
    VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
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
  const locks: LockManager = {
    query: async () => ({ held: [], pending: [] }),
    request: requestExclusiveLock,
  };
  const navigator = { locks } satisfies Pick<Navigator, "locks">;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage, navigator, setTimeout: globalThis.setTimeout },
  });
}

function requestExclusiveLock<T>(
  name: string,
  callback: LockGrantedCallback<T>,
): Promise<T>;
function requestExclusiveLock<T>(
  name: string,
  options: LockOptions,
  callback: LockGrantedCallback<T>,
): Promise<T>;
async function requestExclusiveLock<T>(
  name: string,
  optionsOrCallback: LockOptions | LockGrantedCallback<T>,
  callback?: LockGrantedCallback<T>,
): Promise<T> {
  const options =
    typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
  const action =
    typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
  if (action === undefined) throw new Error("Lock callback is required");
  if (options.mode !== undefined && options.mode !== "exclusive") {
    throw new Error("The test lock shim supports exclusive locks only");
  }
  if (options.signal?.aborted) throw options.signal.reason;
  const lock = { name, mode: "exclusive" } satisfies Lock;
  return action(lock);
}
