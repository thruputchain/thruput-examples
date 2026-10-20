import { toBase58 } from "@thruputchain/client";
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
const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
} satisfies GlobalConfig;

describe("creation workflow", () => {
  beforeEach(() => window.localStorage.clear());

  it.each([2, 3])("rejects version-%i workflows, which stored 0x hex identifiers", (version) => {
    const workflow = createCreationWorkflow(config, review(), 10);
    saveCreationWorkflow(config, workflow);
    window.localStorage.setItem(window.localStorage.key(0)!, JSON.stringify({ ...workflow, version }));
    expect(() => loadCreationWorkflow(config, id(1), id(2))).toThrow("Stored pool-creation workflow is invalid");
    expect(() => loadAccountCreationWorkflows(config)).toThrow("Stored pool-creation workflow is invalid");
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
    expect(loadCreationWorkflow(config, id(1), id(2))).toEqual(workflow);
    expect(window.localStorage.key(0)).toContain("groundhog-swap:pool-creation:v2");
  });

  it("ignores retired creation namespaces", () => {
    const key = `groundhog-swap:pool-creation:v1:${config.networkId}:old`;
    window.localStorage.setItem(key, "not-json");
    expect(loadAccountCreationWorkflows(config)).toEqual([]);
    expect(window.localStorage.getItem(key)).toBe("not-json");
  });

  it("reserves total factory funding and both initial token amounts", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    expect(reservedCreationHog([workflow])).toBe(300n);
    expect(reservedCreationToken([workflow], id(1))).toBe(11n);
    expect(reservedCreationToken([workflow], id(2))).toBe(13n);

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
    expect(() => archiveCreationWorkflow({ ...config, networkId: toBase58(new Uint8Array(32).fill(0x01)) }, workflow)).toThrow();
    const archived = archiveCreationWorkflow(config, workflow);
    expect(loadCreationWorkflow(oldConfig, id(1), id(2))).toEqual(archived);
    expect(archived).toMatchObject({ status: "archived", factoryAddress: id(17), routerAddress: id(18) });
    expect(reservedCreationHog([archived])).toBe(0n);
    expect(loadCreationWorkflow(config, id(1), id(2))).toBeNull();
  });

  it.each(["signing", "indeterminate"] as const)("preserves obsolete %s exposure", (status) => {
    const oldConfig = { ...config, factoryAddress: address(17) };
    const workflow = createCreationWorkflow(oldConfig, review());
    workflow.steps.enqueue.status = status;
    saveCreationWorkflow(oldConfig, workflow);
    expect(() => archiveCreationWorkflow(config, workflow)).toThrow();
    expect(loadCreationWorkflow(oldConfig, id(1), id(2))).toEqual(workflow);
  });
});

function review(): PoolCreationReview {
  const token = (byte: number, amount: bigint) => ({
    address: address(byte),
    addressBase58: id(byte),
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
