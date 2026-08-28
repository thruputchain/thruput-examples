import { fixedBytes } from "@groundhogchain/client";
import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import type { FactoryReview } from "@/contracts/launchpad-client";
import {
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
    networkIdHex: "01".repeat(32),
    accountAddress: contractAddress(new Uint8Array(32).fill(2)),
    factoryAddress: contractAddress(new Uint8Array(32).fill(3)),
    nativeHogAddress: contractAddress(new Uint8Array(32)),
    nativeBalanceItemCost: 10n,
    expectedTokenHash: new Uint8Array(32),
  };
}
