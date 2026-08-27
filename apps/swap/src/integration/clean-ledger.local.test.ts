/// <reference types="node" />

import { toHex0x, type TransactionReceipt } from "@groundhogchain/client";
import { describe, expect, it } from "vitest";

import { loadAppConfig, type AppConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { buildProcessRequestsTarget } from "@/contracts/driver-target";
import { RequestAccepted } from "@/contracts/generated/swap-driver";
import {
  BurnEvent,
  MintEvent,
  SwapEvent,
} from "@/contracts/generated/swap-pair";
import { buildExactInputSwapTarget } from "@/contracts/router-target";
import { parseDevelopmentPersonas } from "@/development-personas";
import { orientReserves, orderTokens } from "@/domain/tokens";
import {
  deriveAddLiquidityQuote,
  deriveRemoveLiquidityQuote,
} from "@/pools/liquidity-model";
import { readPoolDirectory } from "@/pools/pool-directory";
import { deriveSwapQuote } from "@/swap/model";
import { createSnapshotReader } from "@/swap/snapshot";
import { runLiquidityOperation } from "@/transactions/liquidity-executor";
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

const runCleanLedger =
  import.meta.env.MODE === "local-integration" &&
  process.env.RUN_CLEAN_LEDGER_E2E === "1";

describe.skipIf(!runCleanLedger)("clean-ledger AMM acceptance", () => {
  it("runs the seeded pool journey across Alice, Carol, and Bob", async () => {
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
    expect(toHex0x(directory.entries[0]!.config.pairAddress)).toBe(
      toHex0x(baseConfig.pairAddress),
    );
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
      expect.arrayContaining(["gEUR", "gUSD", "HOG"]),
    );
    expect(alicePortfolio.liquidityPositions).toHaveLength(1);
    expect(alicePortfolio.liquidityPositions[0]!.balance).toBeGreaterThan(0n);
    expect((await createWalletPortfolioReader(bobConfig)()).liquidityPositions)
      .toHaveLength(0);

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
          contractAddress: carolConfig.pairAddress,
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
      (minted / 2n).toString(),
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
          contractAddress: carolConfig.pairAddress,
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
        pairAddress: toHex0x(bobConfig.pairAddress),
        handlerAddress: toHex0x(bobConfig.handlerAddress),
        driverAddress: toHex0x(bobConfig.driverAddress),
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
      contractAddress: bobConfig.pairAddress,
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

    const refreshedDirectory = await readPoolDirectory(bobConfig);
    expect(refreshedDirectory.entries).toHaveLength(1);
    expect(refreshedDirectory.entries[0]!.snapshot.reserve0).toBe(
      afterSwap.reserve0,
    );
    expect(refreshedDirectory.entries[0]!.snapshot.reserve1).toBe(
      afterSwap.reserve1,
    );
  }, 180_000);
});

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

function forPersona(
  config: AppConfig,
  accountAddress: AppConfig["accountAddress"],
): AppConfig {
  return { ...config, accountAddress };
}

function loadLocalConfig(): AppConfig {
  return loadAppConfig({
    VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
    VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
    VITE_GROUNDHOG_WALLET_ADDRESS: import.meta.env
      .VITE_GROUNDHOG_WALLET_ADDRESS,
    VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
    VITE_SWAP_FACTORY_ADDRESS: import.meta.env.VITE_SWAP_FACTORY_ADDRESS,
    VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
    VITE_POOL_CONTRACT_FUNDING: import.meta.env.VITE_POOL_CONTRACT_FUNDING,
    VITE_SWAP_PAIR_ADDRESS: import.meta.env.VITE_SWAP_PAIR_ADDRESS,
    VITE_SWAP_LIQUIDITY_TOKEN_ADDRESS: import.meta.env
      .VITE_SWAP_LIQUIDITY_TOKEN_ADDRESS,
    VITE_SWAP_HANDLER_ADDRESS: import.meta.env.VITE_SWAP_HANDLER_ADDRESS,
    VITE_SWAP_DRIVER_ADDRESS: import.meta.env.VITE_SWAP_DRIVER_ADDRESS,
    VITE_TOKEN_A_ADDRESS: import.meta.env.VITE_TOKEN_A_ADDRESS,
    VITE_TOKEN_B_ADDRESS: import.meta.env.VITE_TOKEN_B_ADDRESS,
    VITE_TOKEN_A_SYMBOL: import.meta.env.VITE_TOKEN_A_SYMBOL,
    VITE_TOKEN_B_SYMBOL: import.meta.env.VITE_TOKEN_B_SYMBOL,
    VITE_TOKEN_DECIMALS: import.meta.env.VITE_TOKEN_DECIMALS,
  });
}
