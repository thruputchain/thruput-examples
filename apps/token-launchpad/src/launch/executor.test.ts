import {
  fixedBytes,
  type GroundhogClient,
  type TransactionReceipt,
} from "@groundhogchain/client";
import { describe, expect, it, vi } from "vitest";

import type { FactoryReview } from "@/contracts/launchpad-client";
import { advanceWorkflow } from "@/launch/executor";
import {
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  workflowIntent,
  workflowStorageKey,
} from "@/launch/workflow";
import { configuration, MemoryStorage } from "@/launch/workflow.test";
import type { WriteBoundary } from "@/transactions/write-boundary";

const locks = {
  request: async (_name: string, callback: (lock: Lock) => unknown) =>
    callback({ name: "launch", mode: "exclusive" }),
} as unknown as LockManager;

describe("advanceWorkflow", () => {
  it("persists the signed hash before returning an uncertain funding result", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const hash = `0x${"06".repeat(32)}`;
    let signedWasPersisted = false;
    const writer: WriteBoundary = {
      async execute(_invocation, observer) {
        observer.onSigned(hash);
        signedWasPersisted =
          loadWorkflow(storage, workflowStorageKey(config))?.funding.hash ===
          hash;
        return { kind: "indeterminate", hash, reason: "disconnect" };
      },
      async observe() {
        throw new Error("observe should not run");
      },
    };
    const result = await advanceWorkflow({
      config,
      client: {} as GroundhogClient,
      writer,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => factoryReview(config),
    });
    expect(signedWasPersisted).toBe(true);
    expect(result.funding).toEqual({ status: "uncertain", hash });
    expect(result.reviewedReserve).toBe("0");
    expect(result.reviewedFundingAmount).toBe("110");
  });

  it("requires renewed review when the funding plan changes", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = { execute: vi.fn(), observe: vi.fn() };
    const result = await advanceWorkflow({
      config,
      client: {} as GroundhogClient,
      writer: writer as unknown as WriteBoundary,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => ({
        ...factoryReview(config),
        currentReserve: 5n,
        fundingAmount: 95n,
      }),
    });
    expect(result.plannedReserve).toBe("5");
    expect(result.plannedFundingAmount).toBe("95");
    expect(result.reviewedReserve).toBe("0");
    expect(result.reviewedFundingAmount).toBe("110");
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("returns after a zero-funding transition before signing creation", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    let workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = { execute: vi.fn(), observe: vi.fn() };
    const fundedReview = {
      ...factoryReview(config),
      currentReserve: 100n,
      fundingAmount: 0n,
    };
    workflow = await advanceWorkflow({
      config,
      client: {} as GroundhogClient,
      writer: writer as unknown as WriteBoundary,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => fundedReview,
    });
    workflow = await advanceWorkflow({
      config,
      client: {} as GroundhogClient,
      writer: writer as unknown as WriteBoundary,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => fundedReview,
    });
    expect(workflow.funding.status).toBe("committed");
    expect(workflow.creation.status).toBe("idle");
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("observes pending funding evidence even when the reserve is now full", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const hash = `0x${"08".repeat(32)}`;
    const workflow = {
      ...createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      ),
      funding: { status: "pending" as const, hash },
    };
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = {
      execute: vi.fn(),
      observe: vi.fn().mockResolvedValue({
        kind: "committedSuccess",
        hash,
        receipt: {} as TransactionReceipt,
      }),
    };
    const result = await advanceWorkflow({
      config,
      client: {} as GroundhogClient,
      writer: writer as unknown as WriteBoundary,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => ({
        ...factoryReview(config),
        currentReserve: 100n,
        fundingAmount: 0n,
      }),
    });
    expect(writer.observe).toHaveBeenCalledWith(hash);
    expect(writer.execute).not.toHaveBeenCalled();
    expect(result.funding.status).toBe("committed");
    expect(result.creation.status).toBe("idle");
  });

  it("stops before signing when the active wallet cannot fund the token", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const reviewed = factoryReview(config);
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      reviewed,
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = { execute: vi.fn(), observe: vi.fn() };
    await expect(
      advanceWorkflow({
        config,
        client: {} as GroundhogClient,
        writer: writer as unknown as WriteBoundary,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
        storage,
        locks,
        review: async () => ({
          ...reviewed,
          creatorBalance: 10n,
          fundingShortfall: 100n,
        }),
      }),
    ).rejects.toThrow(/Insufficient HOG.*100 more HOG/);
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("bounds and redacts an invalid transaction reason", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const secret = `0x${"ab".repeat(64)}`;
    const result = await advanceWorkflow({
      config,
      client: {} as GroundhogClient,
      writer: {
        execute: async () => ({
          kind: "invalid",
          hash: `0x${"06".repeat(32)}`,
          reason: `${secret} ${"upstream".repeat(100)}`,
        }),
        observe: vi.fn(),
      },
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => factoryReview(config),
    });
    expect(result.funding.status).toBe("failed");
    expect(result.error).not.toContain(secret);
    expect(result.error!.length).toBeLessThanOrEqual(300);
  });

  it("observes stored evidence instead of submitting a duplicate", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const hash = `0x${"07".repeat(32)}`;
    const workflow = {
      ...createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      ),
      funding: { status: "uncertain" as const, hash },
    };
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    let executions = 0;
    const writer: WriteBoundary = {
      async execute() {
        executions += 1;
        throw new Error("execute should not run");
      },
      async observe(observedHash) {
        expect(observedHash).toBe(hash);
        return {
          kind: "committedSuccess",
          hash,
          receipt: {} as TransactionReceipt,
        };
      },
    };
    const result = await advanceWorkflow({
      config,
      client: {} as GroundhogClient,
      writer,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => ({
        ...factoryReview(config),
        creatorBalance: 0n,
        fundingShortfall: 110n,
      }),
    });
    expect(executions).toBe(0);
    expect(result.funding.status).toBe("committed");
  });

  it("rejects a stale tab after acquiring the lock", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    await expect(
      advanceWorkflow({
        config,
        client: {} as GroundhogClient,
        writer: {} as WriteBoundary,
        workflowId: "stale",
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
        storage,
        locks,
        review: async () => factoryReview(config),
      }),
    ).rejects.toThrow(/changed in another tab/);
  });

  it("rejects a stale revision of the same workflow", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = {
      ...createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      ),
      revision: 1,
    };
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    await expect(
      advanceWorkflow({
        config,
        client: {} as GroundhogClient,
        writer: {} as WriteBoundary,
        workflowId: workflow.id,
        workflowRevision: 0,
        expectedIntent: workflowIntent(workflow),
        storage,
        locks,
        review: async () => factoryReview(config),
      }),
    ).rejects.toThrow(/changed in another tab/);
  });

  it("pauses when any reviewed immutable factory value changes", async () => {
    const config = configuration();
    const reviewed = factoryReview(config);
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      reviewed,
    );
    const changedConfigs = [
      { ...reviewed.config, native_token: config.factoryAddress },
      {
        ...reviewed.config,
        token_code_hash: fixedBytes(new Uint8Array(32).fill(1), 32),
      },
      { ...reviewed.config, required_token_funding: 101n },
      { ...reviewed.config, creation_fee: 1n },
      { ...reviewed.config, fee_recipient: config.factoryAddress },
    ];
    for (const changedConfig of changedConfigs) {
      const storage = new MemoryStorage();
      saveWorkflow(storage, workflowStorageKey(config), workflow);
      const writer = { execute: vi.fn(), observe: vi.fn() };
      await expect(
        advanceWorkflow({
          config,
          client: {} as GroundhogClient,
          writer: writer as unknown as WriteBoundary,
          workflowId: workflow.id,
          workflowRevision: workflow.revision,
          expectedIntent: workflowIntent(workflow),
          storage,
          locks,
          review: async () => ({ ...reviewed, config: changedConfig }),
        }),
      ).rejects.toThrow(/factory state changed/);
      expect(writer.execute).not.toHaveBeenCalled();
    }
  });

  it("rejects a valid same-revision intent change after review", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), {
      ...workflow,
      token: { ...workflow.token, initialSupply: "13" },
    });
    const writer = { execute: vi.fn(), observe: vi.fn() };
    await expect(
      advanceWorkflow({
        config,
        client: {} as GroundhogClient,
        writer: writer as unknown as WriteBoundary,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
        storage,
        locks,
        review: async () => factoryReview(config),
      }),
    ).rejects.toThrow(/changed in another tab/);
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("requires a separate confirmation to recover pre-hash signing", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = {
      ...createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      ),
      revision: 1,
      funding: { status: "signing" as const, hash: null },
    };
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = {
      execute: vi.fn(),
      observe: vi.fn(),
    } as unknown as WriteBoundary;
    const input = {
      config,
      client: {} as GroundhogClient,
      writer,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks,
      review: async () => factoryReview(config),
    };

    await expect(advanceWorkflow(input)).rejects.toThrow(
      /no transaction was signed/,
    );
    const recovered = await advanceWorkflow({
      ...input,
      confirmUnsignedStep: "funding",
    });
    expect(recovered.funding).toEqual({ status: "idle", hash: null });
    expect(recovered.revision).toBe(2);
    expect(writer.execute).not.toHaveBeenCalled();
  });
});

function factoryReview(config = configuration()): FactoryReview {
  return {
    config: {
      token_code_hash: fixedBytes(new Uint8Array(32), 32),
      required_token_funding: 100n,
      native_token: config.nativeHogAddress,
      creation_fee: 0n,
      fee_recipient: null,
    },
    predictedAddress: config.factoryAddress,
    predictedAddressHex: `0x${"03".repeat(32)}`,
    currentReserve: 0n,
    fundingAmount: 110n,
    creatorBalance: 1_000n,
    fundingShortfall: 0n,
  };
}
