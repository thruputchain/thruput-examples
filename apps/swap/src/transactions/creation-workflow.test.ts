import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { GlobalConfig } from "@/config";
import type { PoolCreationReview } from "@/pools/pool-creation";
import {
  archiveCreationWorkflow,
  createCreationWorkflow,
  creationStepOrder,
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
  knownTokenAddresses: [],
} satisfies GlobalConfig;

describe("creation workflow", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts the atomic factory workflow in the v2 namespace", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    saveCreationWorkflow(config, workflow);

    expect(creationStepOrder).toEqual([
      "approveFunding",
      "createPool",
      "approveToken0",
      "approveToken1",
      "enqueue",
      "crank",
    ]);
    expect(loadCreationWorkflow(config, hex(1), hex(2))).toEqual(workflow);
    expect(window.localStorage.key(0)).toContain("groundhog-swap:pool-creation:v2");
  });

  it("ignores retired creation namespaces", () => {
    const key = `groundhog-swap:pool-creation:v1:${config.networkIdHex}:old`;
    window.localStorage.setItem(key, "not-json");
    expect(loadAccountCreationWorkflows(config)).toEqual([]);
    expect(window.localStorage.getItem(key)).toBe("not-json");
  });

  it("reserves total factory funding and both initial token amounts", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    expect(reservedCreationHog([workflow])).toBe(300n);
    expect(reservedCreationToken([workflow], hex(1))).toBe(11n);
    expect(reservedCreationToken([workflow], hex(2))).toBe(13n);
  });

  it("archives only workflows without execution exposure", () => {
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));
    expect(archiveCreationWorkflow(config, workflow).status).toBe("archived");
  });
});

function review(): PoolCreationReview {
  const token = (byte: number, amount: bigint) => ({
    address: address(byte),
    addressHex: hex(byte),
    name: `Token ${byte}`,
    symbol: `T${byte}`,
    decimals: 0,
    balance: 1_000n,
    allowance: 0n,
    amount,
    approvalDifference: amount,
  });
  return {
    token0: token(1, 11n),
    token1: token(2, 13n),
    pool: null,
    nativeHogBalance: 1_000n,
    nativeHogAllowance: 0n,
    fundingMinimum: 50n,
    fundingPerContract: 100n,
    totalFunding: 300n,
    fundingApprovalDifference: 300n,
    initialLiquidity: 1n,
    readHeight: 1n,
  };
}
