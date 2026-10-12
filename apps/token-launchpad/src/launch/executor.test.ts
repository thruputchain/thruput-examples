import {
  fixedBytes,
  fromHex0x,
  type GroundhogClient,
  type TransactionReceipt,
} from "@groundhogchain/client";
import { describe, expect, it, vi } from "vitest";
import { ExecResult } from "@groundhogchain/protocol";

import type { FactoryReview } from "@/contracts/launchpad-client";
import { createReadClient } from "@/thruput/client";
import { advanceWorkflow, runWorkflow } from "@/launch/executor";
import {
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  workflowLockName,
  workflowIntent,
  workflowSessionLockName,
  workflowStorageKey,
} from "@/launch/workflow";
import { configuration, MemoryStorage } from "@/test/fixtures";
import type { WriteBoundary } from "@/transactions/write-boundary";

const locks = {
  request: async (_name: string, callback: (lock: Lock) => unknown) =>
    callback({ name: "launch", mode: "exclusive" }),
} as unknown as LockManager;

describe("advanceWorkflow", () => {
  it("persists one batch hash for both steps and recovers it without individual submissions", async () => {
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
    const writer: WriteBoundary = {
      supportsBatch: vi.fn().mockResolvedValue(true),
      execute: vi.fn(),
      observe: vi
        .fn()
        .mockResolvedValue({ kind: "invalid", hash, reason: "expired" }),
      executeBatch: vi.fn<NonNullable<WriteBoundary["executeBatch"]>>(
        async (calls, observer) => {
          expect(calls).toHaveLength(2);
          await observer.onSigned(hash);
          const saved = loadWorkflow(storage, workflowStorageKey(config))!;
          expect(saved.funding).toEqual({ status: "pending", hash });
          expect(saved.creation).toEqual(saved.funding);
          return { kind: "indeterminate", hash, reason: "timeout" };
        },
      ),
    };
    const input = {
      config,
      client: {} as GroundhogClient,
      writer,
      storage,
      locks,
      automatic: true,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      review: async () => factoryReview(config),
    };
    const pending = await runWorkflow(input);
    expect(pending.executionMode).toBe("batch");
    expect(pending.creation.status).toBe("uncertain");
    const recovered = await runWorkflow({
      ...input,
      workflowRevision: pending.revision,
    });
    expect(recovered.funding.status).toBe("failed");
    expect(recovered.creation).toEqual(recovered.funding);
    expect(writer.observe).toHaveBeenCalledExactlyOnceWith(hash);
    expect(writer.executeBatch).toHaveBeenCalledTimes(1);
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("keeps a rejected batch together and allows an explicit batch retry", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = {
      supportsBatch: vi.fn().mockResolvedValue(true),
      execute: vi.fn(),
      observe: vi.fn(),
      executeBatch: vi.fn().mockResolvedValue({
        kind: "preSubmissionFailure",
        hash: null,
        message: "User rejected the request",
      }),
    };
    const input = {
      config,
      client: {} as GroundhogClient,
      writer,
      storage,
      locks,
      automatic: true,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      review: async () => factoryReview(config),
    };
    const rejected = await runWorkflow(input);
    expect(rejected.funding.status).toBe("idle");
    expect(rejected.creation.status).toBe("idle");
    expect(writer.execute).not.toHaveBeenCalled();
    await runWorkflow({ ...input, workflowRevision: rejected.revision });
    expect(writer.executeBatch).toHaveBeenCalledTimes(2);
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("does not batch saved legacy workflows or bypass a capability error", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    const writer = {
      supportsBatch: vi
        .fn()
        .mockRejectedValue(new Error("Capability unavailable")),
      executeBatch: vi.fn(),
      execute: vi.fn().mockResolvedValue({
        kind: "preSubmissionFailure",
        hash: null,
        message: "Rejected",
      }),
      observe: vi.fn(),
    };
    const input = {
      config,
      client: {} as GroundhogClient,
      writer,
      storage,
      locks,
      automatic: true,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      review: async () => factoryReview(config),
    };
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    await expect(runWorkflow(input)).rejects.toThrow("Capability unavailable");
    expect(writer.execute).not.toHaveBeenCalled();
    const { executionMode, ...legacy } = workflow;
    storage.setItem(workflowStorageKey(config), JSON.stringify(legacy));
    const result = await runWorkflow(input);
    expect(result.executionMode).toBe("single");
    expect(writer.execute).toHaveBeenCalledOnce();
    expect(writer.executeBatch).not.toHaveBeenCalled();
    expect(writer.supportsBatch).toHaveBeenCalledOnce();
  });
  it.each(["pending", "uncertain"] as const)(
    "only observes recovered %s funding even when automatic continuation was requested",
    async (status) => {
      const config = configuration();
      const storage = new MemoryStorage();
      const hash = `0x${"06".repeat(32)}`;
      const workflow = {
        ...createWorkflow(
          config,
          { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
          new Uint8Array(32).fill(5),
          factoryReview(config),
        ),
        funding: { status, hash },
      };
      saveWorkflow(storage, workflowStorageKey(config), workflow);
      const writer = {
        observe: vi
          .fn()
          .mockResolvedValue({ kind: "committedSuccess", hash, receipt: {} }),
        execute: vi.fn().mockResolvedValue({
          kind: "preSubmissionFailure",
          hash: null,
          message: "creation rejected",
        }),
      };
      const input = {
        config,
        client: {} as GroundhogClient,
        writer,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
        storage,
        locks,
        automatic: true,
        review: async () => ({
          ...factoryReview(config),
          currentReserve: 100n,
          fundingAmount: 0n,
        }),
      };
      const recovered = await runWorkflow(input);
      expect(writer.observe).toHaveBeenCalledExactlyOnceWith(hash);
      expect(writer.execute).not.toHaveBeenCalled();
      expect(recovered.funding.status).toBe("committed");
      expect(recovered.creation.status).toBe("idle");
      await runWorkflow({
        ...input,
        automatic: false,
        workflowRevision: recovered.revision,
      });
      expect(writer.execute).toHaveBeenCalledOnce();
    },
  );
  it.each(["caught-up", "still-stale", "fresh-shortfall"])(
    "handles %s reserve evidence after committed funding without re-funding",
    async (state) => {
      const config = configuration();
      const storage = new MemoryStorage();
      const hash = `0x${"06".repeat(32)}`;
      const initial = createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      );
      const workflow = {
        ...initial,
        funding: { status: "committed" as const, hash },
      };
      saveWorkflow(storage, workflowStorageKey(config), workflow);
      const review = vi.fn().mockResolvedValue({
        ...factoryReview(config),
        reserveHeight: state === "fresh-shortfall" ? 10n : 9n,
      });
      if (state === "caught-up")
        review
          .mockResolvedValueOnce({
            ...factoryReview(config),
            reserveHeight: 9n,
          })
          .mockResolvedValue({
            ...factoryReview(config),
            reserveHeight: 10n,
            currentReserve: 100n,
            fundingAmount: 0n,
          });
      const client = {
        getTransactionReceipt: vi.fn().mockResolvedValue({
          txHash: fromHex0x(hash),
          height: 10n,
          execResult: ExecResult.ExecResultOK,
        }),
      } as unknown as GroundhogClient;
      const writer = {
        execute: vi.fn().mockResolvedValue({
          kind: "preSubmissionFailure",
          hash: null,
          message: "Creation signing not approved",
        }),
        observe: vi.fn(),
      };
      const result = advanceWorkflow({
        config,
        client,
        writer,
        review,
        storage,
        locks,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
      });
      if (state === "caught-up") {
        expect((await result).funding).toEqual(workflow.funding);
        expect(writer.execute).toHaveBeenCalledOnce();
        expect(
          writer.execute.mock.calls[0]![0].invocation.invoked_address,
        ).toEqual(config.factoryAddress);
      } else {
        await expect(result).rejects.toThrow(
          state === "still-stale"
            ? /snapshot has not reached/
            : /required reserve is not available/,
        );
        expect(writer.execute).not.toHaveBeenCalled();
        expect(
          loadWorkflow(storage, workflowStorageKey(config))!.funding,
        ).toEqual(workflow.funding);
      }
      expect(review).toHaveBeenCalledTimes(
        state === "fresh-shortfall" ? 1 : state === "still-stale" ? 4 : 2,
      );
      expect(writer.observe).not.toHaveBeenCalled();
    },
  );
  it.each(["mismatch", "malformed", "unavailable"])(
    "does not execute or recover a workflow from %s network evidence",
    async (failure) => {
      const config = configuration();
      const storage = new MemoryStorage();
      const workflow = createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      );
      const writer = { execute: vi.fn(), observe: vi.fn() };
      const methods: string[] = [];
      let initialized = false;
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, init) => {
          const request = JSON.parse(init!.body as string);
          methods.push(request.method);
          if (initialized && failure === "unavailable")
            throw new Error("offline");
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                networkHash: !initialized
                  ? `0x${config.networkIdHex}`
                  : failure === "mismatch"
                    ? `0x${"99".repeat(32)}`
                    : "broken",
              },
            }),
          );
        });
      try {
        const client = await createReadClient(config);
        initialized = true;
        methods.length = 0;
        for (const status of ["idle", "signing", "uncertain"] as const) {
          const saved = {
            ...workflow,
            funding: {
              status,
              hash: status === "uncertain" ? `0x${"06".repeat(32)}` : null,
            },
          };
          saveWorkflow(storage, workflowStorageKey(config), saved);
          await expect(
            advanceWorkflow({
              config,
              client,
              writer,
              storage,
              locks,
              workflowId: saved.id,
              workflowRevision: saved.revision,
              expectedIntent: workflowIntent(saved),
              confirmUnsignedStep: "funding",
            }),
          ).rejects.toThrow();
          expect(loadWorkflow(storage, workflowStorageKey(config))).toEqual(
            saved,
          );
        }
        expect(writer.execute).not.toHaveBeenCalled();
        expect(writer.observe).not.toHaveBeenCalled();
        expect(methods).toEqual(Array(3).fill("groundhog_networkInfo"));
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it.each([
    ["automatic", true, 2],
    ["manual", false, 1],
  ] as const)(
    "%s processing controls whether creation follows committed funding",
    async (_mode, automatic, expectedExecutions) => {
      const config = configuration();
      const storage = new MemoryStorage();
      const workflow = createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      );
      saveWorkflow(storage, workflowStorageKey(config), workflow);
      const writer = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            kind: "committedSuccess",
            hash: `0x${"06".repeat(32)}`,
            receipt: {} as TransactionReceipt,
          })
          .mockResolvedValueOnce({
            kind: "preSubmissionFailure",
            message: "creation unavailable",
          }),
        observe: vi.fn(),
      };
      const review = vi
        .fn()
        .mockResolvedValueOnce(factoryReview(config))
        .mockResolvedValue({
          ...factoryReview(config),
          currentReserve: 100n,
          fundingAmount: 0n,
        });
      const onUpdate = vi.fn();
      const lockEvents: string[] = [];
      const trackingLocks = {
        request: async (name: string, callback: (lock: Lock) => unknown) => {
          lockEvents.push(`start:${name}`);
          try {
            return await callback({ name, mode: "exclusive" });
          } finally {
            lockEvents.push(`end:${name}`);
          }
        },
      } as unknown as LockManager;
      const result = await runWorkflow({
        config,
        client: {} as GroundhogClient,
        writer,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
        storage,
        locks: trackingLocks,
        review,
        automatic,
        onUpdate,
      });
      expect(writer.execute).toHaveBeenCalledTimes(expectedExecutions);
      expect(
        onUpdate.mock.calls.map(([next]) => [
          next.funding.status,
          next.creation.status,
        ]),
      ).toEqual(
        automatic
          ? [
              ["signing", "idle"],
              ["committed", "idle"],
              ["committed", "signing"],
              ["committed", "idle"],
            ]
          : [
              ["signing", "idle"],
              ["committed", "idle"],
            ],
      );
      expect(result.funding.status).toBe("committed");
      expect(result.creation.status).toBe("idle");
      expect(result.error).toBe(automatic ? "creation unavailable" : null);
      const workflowLock = workflowLockName(config);
      expect(lockEvents).toEqual(
        automatic
          ? [
              `start:${workflowSessionLockName(config)}`,
              `start:${workflowLock}`,
              `end:${workflowLock}`,
              `start:${workflowLock}`,
              `end:${workflowLock}`,
              `end:${workflowSessionLockName(config)}`,
            ]
          : [`start:${workflowLock}`, `end:${workflowLock}`],
      );
    },
  );

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

  it("blocks a persona switch across the full automatic sequence", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const lockManager = exclusiveLockManager();
    let releaseFunding!: () => void;
    let markFundingStarted!: () => void;
    const fundingStarted = new Promise<void>((resolve) => {
      markFundingStarted = resolve;
    });
    const fundingGate = new Promise<void>((resolve) => {
      releaseFunding = resolve;
    });
    const writer = {
      execute: vi
        .fn()
        .mockImplementationOnce(async () => {
          markFundingStarted();
          await fundingGate;
          return {
            kind: "committedSuccess" as const,
            hash: `0x${"06".repeat(32)}`,
            receipt: {} as TransactionReceipt,
          };
        })
        .mockResolvedValueOnce({
          kind: "preSubmissionFailure",
          message: "creation unavailable",
        }),
      observe: vi.fn(),
    };
    const review = vi
      .fn()
      .mockResolvedValueOnce(factoryReview(config))
      .mockResolvedValue({
        ...factoryReview(config),
        currentReserve: 100n,
        fundingAmount: 0n,
      });

    const automaticRun = runWorkflow({
      config,
      client: {} as GroundhogClient,
      writer,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      expectedIntent: workflowIntent(workflow),
      storage,
      locks: lockManager,
      review,
      automatic: true,
    });
    await fundingStarted;
    let switchedAfterExecutions: number | null = null;
    const switchRequest = lockManager.request(
      workflowSessionLockName(config),
      () => {
        switchedAfterExecutions = writer.execute.mock.calls.length;
      },
    );
    await Promise.resolve();
    expect(switchedAfterExecutions).toBeNull();

    releaseFunding();
    await automaticRun;
    await switchRequest;
    expect(switchedAfterExecutions).toBe(2);
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

  it("observes pending creation evidence after deployment consumes the reserve", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const hash = `0x${"09".repeat(32)}`;
    const workflow = {
      ...createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      ),
      funding: {
        status: "committed" as const,
        hash: `0x${"08".repeat(32)}`,
      },
      creation: { status: "pending" as const, hash },
    };
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = {
      execute: vi.fn(),
      observe: vi.fn().mockResolvedValue({
        kind: "indeterminate",
        hash,
        reason: "timeout",
      }),
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
    expect(writer.observe).toHaveBeenCalledWith(hash);
    expect(writer.execute).not.toHaveBeenCalled();
    expect(result.creation).toEqual({ status: "uncertain", hash });
  });

  it("returns a verified creation after deployment consumes the reserve", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const base = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      factoryReview(config),
    );
    const workflow = {
      ...base,
      funding: {
        status: "committed" as const,
        hash: `0x${"08".repeat(32)}`,
      },
      creation: {
        status: "committed" as const,
        hash: `0x${"09".repeat(32)}`,
      },
      verification: {
        status: "complete" as const,
        message: null,
        totalSupply: "12",
        holderBalance: "12",
      },
      createdAddressHex: base.predictedAddressHex,
      creationBlock: "9",
    };
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
      review: async () => factoryReview(config),
    });
    expect(result).toEqual(workflow);
    expect(writer.execute).not.toHaveBeenCalled();
    expect(writer.observe).not.toHaveBeenCalled();
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

  it("does not resubmit creation while confirming a pre-hash recovery", async () => {
    const config = configuration();
    const storage = new MemoryStorage();
    const workflow = {
      ...createWorkflow(
        config,
        { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
        new Uint8Array(32).fill(5),
        factoryReview(config),
      ),
      revision: 2,
      funding: {
        status: "committed" as const,
        hash: `0x${"06".repeat(32)}`,
      },
      creation: { status: "signing" as const, hash: null },
    };
    saveWorkflow(storage, workflowStorageKey(config), workflow);
    const writer = {
      execute: vi.fn(),
      observe: vi.fn(),
    } as unknown as WriteBoundary;
    const recovered = await runWorkflow({
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
        currentReserve: 100n,
        fundingAmount: 0n,
      }),
      automatic: true,
      confirmUnsignedStep: "creation",
    });
    expect(recovered.creation).toEqual({ status: "idle", hash: null });
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
    reserveHeight: 0n,
    fundingAmount: 110n,
    creatorBalance: 1_000n,
    fundingShortfall: 0n,
  };
}

function exclusiveLockManager(): LockManager {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  return {
    async request<T>(
      name: string,
      callback: (lock: Lock) => T | PromiseLike<T>,
    ): Promise<T> {
      await new Promise<void>((resolve) => {
        if (!held.has(name)) {
          held.add(name);
          resolve();
          return;
        }
        const queue = queues.get(name) ?? [];
        queue.push(resolve);
        queues.set(name, queue);
      });
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        const next = queues.get(name)?.shift();
        if (next) next();
        else held.delete(name);
      }
    },
  } as LockManager;
}
