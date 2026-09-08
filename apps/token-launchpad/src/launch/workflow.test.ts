import { fixedBytes } from "@groundhogchain/client";
import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import type { FactoryReview } from "@/contracts/launchpad-client";
import {
  canDiscardInvalidStoredWorkflow,
  assertWorkflowScope,
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  WorkflowStorageError,
} from "@/launch/workflow";

const config = configuration();
const review: FactoryReview = {
  config: {
    token_code_hash: fixedBytes(new Uint8Array(32), 32),
    required_token_funding: 100n,
    native_token: config.nativeHogAddress,
    creation_fee: 0n,
    fee_recipient: null,
  },
  predictedAddress: contractAddress(new Uint8Array(32).fill(4)),
  predictedAddressHex: `0x${"04".repeat(32)}`,
  currentReserve: 0n,
  reserveHeight: 0n,
  fundingAmount: 110n,
  creatorBalance: 1_000n,
  fundingShortfall: 0n,
};

describe("launch workflow persistence", () => {
  it("round-trips a reviewed workflow without bigint JSON values", () => {
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    saveWorkflow(storage, "workflow", workflow);
    expect(loadWorkflow(storage, "workflow")).toEqual(workflow);
    expect(storage.value).toContain('"initialSupply":"12"');
  });

  it("rejects unsupported, malformed, and cross-account evidence", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({ version: 2 });
    expect(() => loadWorkflow(storage, "workflow")).toThrow(
      WorkflowStorageError,
    );

    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    expect(() =>
      assertWorkflowScope(workflow, {
        ...config,
        accountAddress: contractAddress(new Uint8Array(32).fill(9)),
      }),
    ).toThrow(/another account or network/);
  });

  it("only permits invalid stored workflows with pristine transaction steps", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      version: 1,
      funding: { status: "idle", hash: null },
      creation: { status: "idle", hash: null },
      createdAddressHex: null,
      creationBlock: null,
      verification: {
        status: "pending",
        message: null,
        totalSupply: null,
        holderBalance: null,
      },
    });
    expect(canDiscardInvalidStoredWorkflow(storage, "workflow")).toBe(true);

    storage.value = JSON.stringify({
      version: 1,
      funding: { status: "pending", hash: `0x${"06".repeat(32)}` },
      creation: { status: "idle", hash: null },
      createdAddressHex: null,
      creationBlock: null,
      verification: {
        status: "pending",
        message: null,
        totalSupply: null,
        holderBalance: null,
      },
    });
    expect(canDiscardInvalidStoredWorkflow(storage, "workflow")).toBe(false);

    storage.value = JSON.stringify({
      version: 1,
      funding: { status: "idle", hash: null },
      creation: { status: "idle", hash: null },
      createdAddressHex: null,
      creationBlock: "42",
      verification: {
        status: "complete",
        message: null,
        totalSupply: "12",
        holderBalance: "12",
      },
    });
    expect(canDiscardInvalidStoredWorkflow(storage, "workflow")).toBe(false);

    storage.value = "invalid";
    expect(canDiscardInvalidStoredWorkflow(storage, "workflow")).toBe(false);

    storage.value = JSON.stringify({
      version: 3,
      funding: { status: "idle", hash: null },
      creation: { status: "idle", hash: null },
      createdAddressHex: null,
    });
    expect(canDiscardInvalidStoredWorkflow(storage, "workflow")).toBe(false);
  });

  it("turns storage failures into signing-blocking errors", () => {
    expect(() =>
      saveWorkflow(
        { setItem: () => void 0 } as Pick<Storage, "setItem">,
        "workflow",
        {} as never,
      ),
    ).not.toThrow();
    expect(() =>
      saveWorkflow(
        {
          setItem() {
            throw new Error("quota");
          },
        },
        "workflow",
        {} as never,
      ),
    ).toThrow(WorkflowStorageError);
  });

  it("rejects unsafe status and hash combinations", () => {
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    storage.value = JSON.stringify({
      ...workflow,
      funding: { status: "pending", hash: null },
    });
    expect(() => loadWorkflow(storage, "workflow")).toThrow(
      WorkflowStorageError,
    );
    storage.value = JSON.stringify({
      ...workflow,
      creation: { status: "committed", hash: null },
    });
    expect(() => loadWorkflow(storage, "workflow")).toThrow(
      WorkflowStorageError,
    );
    storage.value = JSON.stringify({
      ...workflow,
      funding: { status: "committed", hash: null },
      creation: { status: "committed", hash: `0x${"06".repeat(32)}` },
      createdAddressHex: `0x${"09".repeat(32)}`,
      creationBlock: "10",
      verification: {
        status: "complete",
        message: null,
        totalSupply: "12",
        holderBalance: "12",
      },
    });
    expect(() => loadWorkflow(storage, "workflow")).toThrow(
      WorkflowStorageError,
    );
  });

  it("rejects tampered token and factory values before signing", () => {
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    for (const changed of [
      { ...workflow, token: { ...workflow.token, name: " x" } },
      { ...workflow, token: { ...workflow.token, symbol: "x".repeat(11) } },
      {
        ...workflow,
        token: {
          ...workflow.token,
          initialSupply: ((1n << 127n) + 1n).toString(),
        },
      },
      { ...workflow, reviewedCreationFee: ((1n << 127n) + 1n).toString() },
    ]) {
      storage.value = JSON.stringify(changed);
      expect(() => loadWorkflow(storage, "workflow")).toThrow(
        WorkflowStorageError,
      );
    }
  });

  it("redacts and bounds legacy persisted errors", () => {
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    const secret = `0x${"ab".repeat(64)}`;
    storage.value = JSON.stringify({
      ...workflow,
      error: `${secret} ${"upstream".repeat(100)}`,
    });
    const loaded = loadWorkflow(storage, "workflow")!;
    expect(loaded.error).not.toContain(secret);
    expect(loaded.error!.length).toBeLessThanOrEqual(300);
  });

  it("migrates an earlier version-two funding plan in place", () => {
    const storage = new MemoryStorage();
    const legacy = {
      ...createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        review,
      ),
    } as Partial<ReturnType<typeof createWorkflow>>;
    delete legacy.plannedFundingAmount;
    delete legacy.plannedReserve;
    storage.value = JSON.stringify(legacy);
    const loaded = loadWorkflow(storage, "workflow")!;
    expect(loaded.plannedFundingAmount).toBe(loaded.reviewedFundingAmount);
    expect(loaded.plannedReserve).toBe(loaded.reviewedReserve);
  });
});

export class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

export function configuration(): AppConfig {
  return {
    rpcUrl: new URL("http://127.0.0.1:9545"),
    registryEnabled: false,
    networkIdHex: "01".repeat(32),
    accountAddress: contractAddress(new Uint8Array(32).fill(2)),
    factoryAddress: contractAddress(new Uint8Array(32).fill(3)),
    nativeHogAddress: contractAddress(new Uint8Array(32)),
    nativeBalanceItemCost: 10n,
    expectedTokenHash: new Uint8Array(32),
  };
}
