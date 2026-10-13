import { contractAddress } from "@thruputchain/protocol";
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
} satisfies GlobalConfig;

describe("creation workflow", () => {
  beforeEach(() => window.localStorage.clear());

  it("migrates a version-two workflow as single-call execution", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.steps.createPool = { ...workflow.steps.createPool, status: "indeterminate", transactionHash: hex(40) };
    saveCreationWorkflow(config, workflow);
    window.localStorage.setItem(window.localStorage.key(0)!, JSON.stringify({ ...workflow, version: 2, executionMode: undefined }));
    const expected = { ...workflow, version: 3, executionMode: "single" };
    expect(loadCreationWorkflow(config, hex(1), hex(2))).toEqual(expected);
    expect(loadAccountCreationWorkflows(config)).toEqual([expected]);
  });

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

    workflow.steps.createPool.status = "skipped";
    expect(reservedCreationHog([workflow])).toBe(0n);
  });

  it("archives only workflows without execution exposure", () => {
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));
    expect(archiveCreationWorkflow(config, workflow).status).toBe("archived");
  });

  it("archives obsolete deployments without loosening normal saves or account scope", () => {
    const oldConfig = { ...config, factoryAddress: address(17), routerAddress: address(18) };
    const workflow = saveCreationWorkflow(oldConfig, createCreationWorkflow(oldConfig, review()));
    expect(() => saveCreationWorkflow(config, workflow)).toThrow();
    expect(() => archiveCreationWorkflow({ ...config, accountAddress: address(19) }, workflow)).toThrow();
    expect(() => archiveCreationWorkflow({ ...config, networkIdHex: "01".repeat(32) }, workflow)).toThrow();
    const archived = archiveCreationWorkflow(config, workflow);
    expect(loadCreationWorkflow(oldConfig, hex(1), hex(2))).toEqual(archived);
    expect(archived).toMatchObject({ status: "archived", factoryAddress: hex(17), routerAddress: hex(18) });
    expect(reservedCreationHog([archived])).toBe(0n);
    expect(loadCreationWorkflow(config, hex(1), hex(2))).toBeNull();
  });

  it.each(["signing", "indeterminate"] as const)("preserves obsolete %s exposure", (status) => {
    const oldConfig = { ...config, factoryAddress: address(17) };
    const workflow = createCreationWorkflow(oldConfig, review());
    workflow.steps.enqueue.status = status;
    saveCreationWorkflow(oldConfig, workflow);
    expect(() => archiveCreationWorkflow(config, workflow)).toThrow();
    expect(loadCreationWorkflow(oldConfig, hex(1), hex(2))).toEqual(workflow);
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
