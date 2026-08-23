import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { GlobalConfig } from "@/config";
import type { PoolCreationReview } from "@/pools/pool-creation";
import {
  archiveCreationWorkflow,
  canArchiveCreationWorkflow,
  createCreationWorkflow,
  CreationWorkflowError,
  creationWorkflowKey,
  hasBlockingCreationTransaction,
  loadAccountCreationWorkflows,
  loadCreationWorkflow,
  reservedCreationHog,
  reservedCreationToken,
  saveCreationWorkflow,
} from "./creation-workflow";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  poolContractFunding: 100n,
} satisfies GlobalConfig;

describe("creation workflow", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists immutable reviewed intent before approval revalidation", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    saveCreationWorkflow(config, workflow);

    expect(loadCreationWorkflow(config, hex(1), hex(2))).toEqual(workflow);
    expect(workflow.steps.approveToken0.status).toBe("pending");
    expect(workflow.steps.approveToken1.status).toBe("pending");
    expect(window.localStorage.getItem(
      creationWorkflowKey(config, hex(1), hex(2)),
    )).not.toBeNull();
  });

  it("aggregates remaining HOG and token reservations", () => {
    const first = createCreationWorkflow(config, review(), 10);
    first.steps.fundLiquidityToken.status = "committed";
    const secondReview = review();
    secondReview.token1.address = address(3);
    secondReview.token1.addressHex = hex(3);
    const second = createCreationWorkflow(config, secondReview, 11);
    second.status = "executed";

    expect(reservedCreationHog([first, second])).toBe(300n);
    expect(reservedCreationToken([first, second], hex(1))).toBe(2_000n);
    expect(reservedCreationToken([first, second], hex(3))).toBe(0n);
  });

  it("finds blocking signed or indeterminate steps", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    expect(hasBlockingCreationTransaction(workflow)).toBe(false);

    workflow.steps.fundPair.status = "signing";
    expect(hasBlockingCreationTransaction(workflow)).toBe(true);
  });

  it("loads workflows across factories but rejects malformed scope", () => {
    const first = createCreationWorkflow(config, review(), 10);
    saveCreationWorkflow(config, first);
    const otherConfig = { ...config, factoryAddress: address(10) };
    const other = createCreationWorkflow(otherConfig, review(30), 11);
    saveCreationWorkflow(otherConfig, other);

    expect(loadAccountCreationWorkflows(config)).toHaveLength(2);
    const stored = JSON.parse(window.localStorage.getItem(
      creationWorkflowKey(config, hex(1), hex(2)),
    )!);
    stored.accountAddress = hex(99);
    window.localStorage.setItem(
      creationWorkflowKey(config, hex(1), hex(2)),
      JSON.stringify(stored),
    );
    expect(() => loadAccountCreationWorkflows(config)).toThrow(CreationWorkflowError);
  });

  it("archives only workflows without live or uncertain transactions", () => {
    const pending = createCreationWorkflow(config, review(), 10);
    saveCreationWorkflow(config, pending);
    expect(canArchiveCreationWorkflow(pending)).toBe(true);
    expect(archiveCreationWorkflow(config, pending).status).toBe("archived");

    const queued = createCreationWorkflow(config, review(30), 11);
    queued.status = "queued";
    queued.requestId = hex(50);
    queued.steps.enqueue.status = "committed";
    queued.steps.enqueue.transactionHash = hex(51);
    saveCreationWorkflow(config, queued);
    expect(canArchiveCreationWorkflow(queued)).toBe(false);
    expect(() => archiveCreationWorkflow(config, queued)).toThrow(
      CreationWorkflowError,
    );
  });

  it("rejects queued state without a committed enqueue", () => {
    const invalid = createCreationWorkflow(config, review(), 10);
    invalid.status = "queued";
    invalid.requestId = hex(50);
    window.localStorage.setItem(
      creationWorkflowKey(config, hex(1), hex(2)),
      JSON.stringify(invalid),
    );

    expect(() => loadCreationWorkflow(config, hex(1), hex(2))).toThrow(
      CreationWorkflowError,
    );
  });
});

function review(poolOffset = 20): PoolCreationReview {
  return {
    token0: {
      address: address(1),
      addressHex: hex(1),
      name: "Token 1",
      symbol: "T1",
      decimals: 3,
      balance: 10_000n,
      allowance: 0n,
      amount: 2_000n,
      approvalDifference: 2_000n,
    },
    token1: {
      address: address(2),
      addressHex: hex(2),
      name: "Token 2",
      symbol: "T2",
      decimals: 3,
      balance: 10_000n,
      allowance: 3_000n,
      amount: 3_000n,
      approvalDifference: 0n,
    },
    pool: {
      pair: address(poolOffset),
      liquidityToken: address(poolOffset + 1),
      handler: address(poolOffset + 2),
      driver: address(poolOffset + 3),
    },
    nativeHogBalance: 1_000n,
    fixedFundingPerContract: 100n,
    totalFixedFunding: 400n,
    initialLiquidity: 2_449n,
    readHeight: 7n,
  };
}
