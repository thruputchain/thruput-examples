import { sha256Hash } from "@groundhogchain/protocol";
import { contractAddress, ExecResult } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import type { Erc20ReadAdapter } from "@/contracts/erc20-adapter";
import type { SwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import type { PoolCreationReview } from "@/pools/pool-creation";
import {
  confirmCreationStepWasNotSigned,
  runCreationWorkflow,
} from "./creation-executor";
import {
  createCreationWorkflow,
  hasBlockingCreationTransaction,
  loadCreationWorkflow,
  saveCreationWorkflow,
} from "./creation-workflow";
import type { WriteBoundary, WriteResult } from "./write-boundary";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const view = <T>(value: T) => ({ value, height: 7n, events: [] });
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  poolContractFunding: 100n,
} satisfies GlobalConfig;

describe("creation executor", () => {
  beforeEach(() => window.localStorage.clear());

  it("funds contracts sequentially and stops safely before a failed enqueue", async () => {
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const execute = vi.fn()
      .mockResolvedValueOnce(committed(11n))
      .mockResolvedValueOnce(committed(12n))
      .mockResolvedValueOnce(committed(13n))
      .mockResolvedValueOnce(committed(14n))
      .mockResolvedValueOnce({
        kind: "preSubmissionFailure",
        hash: null,
        message: "wallet unavailable",
      } satisfies WriteResult);

    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies(),
      writeBoundary: { execute },
    });

    expect(execute).toHaveBeenCalledTimes(5);
    expect(result.steps.fundLiquidityToken.status).toBe("committed");
    expect(result.steps.fundDriver.status).toBe("committed");
    expect(result.steps.approveToken0.status).toBe("skipped");
    expect(result.steps.approveToken1.status).toBe("skipped");
    expect(result.steps.enqueue).toMatchObject({
      status: "failed",
      transactionHash: null,
      message: "wallet unavailable",
    });
  });

  it("preserves an indeterminate hash for observation", async () => {
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const writer: WriteBoundary = {
      execute: vi.fn(async (_target, observer) => {
        observer?.onSigned(hex(40));
        return {
          kind: "indeterminate",
          hash: hex(40),
          reason: "timeout",
        } satisfies WriteResult;
      }),
      observe: vi.fn(async () => ({
        kind: "invalid",
        hash: hex(40),
        reason: "expired",
      } satisfies WriteResult)),
    };

    const blocked = await runCreationWorkflow(config, workflow, {
      ...dependencies(),
      writeBoundary: writer,
    });
    expect(blocked.steps.fundLiquidityToken).toMatchObject({
      status: "indeterminate",
      transactionHash: hex(40),
    });
    expect(hasBlockingCreationTransaction(blocked)).toBe(true);

    const recovered = await runCreationWorkflow(config, blocked, {
      ...dependencies(),
      writeBoundary: writer,
    });
    expect(writer.observe).toHaveBeenCalledWith(hex(40));
    expect(recovered.steps.fundLiquidityToken.status).toBe("failed");
  });

  it("requires explicit confirmation before retrying a pre-hash step", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.steps.fundLiquidityToken.status = "signing";
    saveCreationWorkflow(config, workflow);

    const reset = confirmCreationStepWasNotSigned(
      config,
      workflow,
      "fundLiquidityToken",
    );

    expect(reset.steps.fundLiquidityToken.status).toBe("pending");
    expect(loadCreationWorkflow(config, hex(1), hex(2))).toEqual(reset);
  });

  it("reloads authoritative progress after acquiring the account lock", async () => {
    const stale = createCreationWorkflow(config, review(), 10);
    saveCreationWorkflow(config, stale);
    saveCreationWorkflow(config, {
      ...stale,
      updatedAt: 11,
      steps: {
        ...stale.steps,
        fundLiquidityToken: {
          status: "committed",
          transactionHash: hex(50),
          message: null,
          updatedAt: 11,
        },
      },
    });
    const execute = vi.fn().mockResolvedValue({
      kind: "preSubmissionFailure",
      hash: null,
      message: "stop after one attempt",
    } satisfies WriteResult);

    const result = await runCreationWorkflow(config, stale, {
      ...dependencies(),
      writeBoundary: { execute },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.steps.fundLiquidityToken.status).toBe("committed");
    expect(result.steps.fundPair.status).toBe("failed");
  });
});

function dependencies(): {
  factory: SwapFactoryReadAdapter;
  token: (token: ReturnType<typeof address>) => Erc20ReadAdapter;
} {
  return {
    factory: {
      allPairsLength: async () => view(0n),
      pairAt: async () => view(null),
      getPair: async () => view(null),
      poolAddresses: async () => view(review().pool),
      feeTo: async () => view(null),
    },
    token: (token) => ({
      balanceOf: async () => view(token[0] === 6 ? 10_000n : 20_000n),
      allowance: async () => view(20_000n),
      metadata: async () => ({
        name: view(`Token ${token[0]}`),
        symbol: view(`T${token[0]}`),
        decimals: view(token[0] === 6 ? null : 3),
      }),
    }),
  };
}

function review(): PoolCreationReview {
  return {
    token0: {
      address: address(1),
      addressHex: hex(1),
      name: "Token 1",
      symbol: "T1",
      decimals: 3,
      balance: 20_000n,
      allowance: 20_000n,
      amount: 2_000n,
      approvalDifference: 0n,
    },
    token1: {
      address: address(2),
      addressHex: hex(2),
      name: "Token 2",
      symbol: "T2",
      decimals: 3,
      balance: 20_000n,
      allowance: 20_000n,
      amount: 3_000n,
      approvalDifference: 0n,
    },
    pool: {
      pair: address(20),
      liquidityToken: address(21),
      handler: address(22),
      driver: address(23),
    },
    nativeHogBalance: 10_000n,
    fixedFundingPerContract: 100n,
    totalFixedFunding: 400n,
    initialLiquidity: 2_449n,
    readHeight: 7n,
  };
}

function committed(height: bigint): Extract<WriteResult, { kind: "committedSuccess" }> {
  return {
    kind: "committedSuccess",
    hash: hex(41),
    receipt: {
      txHash: sha256Hash(new Uint8Array(32).fill(41)),
      height,
      execResult: ExecResult.ExecResultOK,
      events: [],
      returnData: new Uint8Array(),
      abortData: null,
    },
  };
}
