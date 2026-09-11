// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  hashSignedTransaction,
  PrivateKeySigner,
  toHex0x,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  createTransaction,
  serializeSignedTransaction,
  signTransaction,
} from "@groundhogchain/client/transaction";
import { ERC20 } from "@groundhogchain/client/contracts";
import {
  blockHeight,
  ExecResult,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  sha256Hash,
} from "@groundhogchain/protocol";
import { executeStep, saveJson, type SeedJournal } from "./seed-journal.ts";
import { assertScope, readSeedEnvironment } from "./seed.ts";

async function fixture(nonce = 1n) {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const tx = createTransaction({
    invocation: ERC20.transfer.invocation(HOG_ADDRESS, gasAmount(1_000_000n), {
      receiver: account.address,
      amount: 1n,
    }),
    uniquifier: { nonce, block_expiry_height: blockHeight(100n) },
    contracts_to_deploy: [],
    auth_claim: account.authClaim,
  });
  const signed = await signTransaction(
    tx,
    [{ signer, publicKeyId: 0n }],
    networkHash(sha256Hash(new Uint8Array(32).fill(2))),
  );
  const hash = hashSignedTransaction(signed);
  const receipt: TransactionReceipt = {
    txHash: hash,
    height: 10n,
    execResult: ExecResult.ExecResultOK,
    events: [],
    returnData: null,
    abortData: null,
  };
  const client = {
    getTransactionReceipt: vi.fn(async () => null as TransactionReceipt | null),
    getTransactionStatus: vi.fn(async () => ({ status: "pending" as const })),
    getChainTip: vi.fn(async () => ({
      height: blockHeight(50n),
      blockHash: hash,
    })),
    sendTransaction: vi.fn(async () => hash),
    waitForTransactionReceipt: vi.fn(async () => receipt),
  };
  const journal: SeedJournal = { steps: {} };
  const options = {
    name: "create-token",
    intent: "immutable intent",
    journal,
    client,
    save: vi.fn(async () => {}),
    prepare: vi.fn(async () => signed),
  };
  const recorded = () => {
    journal.steps[options.name] = [
      {
        hash: toHex0x(hash),
        signed: toHex0x(serializeSignedTransaction(signed)),
        intent: options.intent,
      },
    ];
  };
  return { ...options, options, signed, hash, receipt, recorded };
}

describe("seed transaction recovery", () => {
  it("persists the canonical hash and signed bytes before sending", async () => {
    const f = await fixture();
    f.client.sendTransaction.mockImplementation(async () => {
      expect(f.save).toHaveBeenCalledOnce();
      expect(f.journal.steps[f.name]?.[0]?.hash).toBe(toHex0x(f.hash));
      return f.hash;
    });
    await executeStep(f.options);
  });

  it("does not broadcast if persistence fails", async () => {
    const f = await fixture();
    f.save.mockRejectedValue(new Error("disk full"));
    await expect(executeStep(f.options)).rejects.toThrow("disk full");
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  it("resumes a pending signed transaction after a lost send response", async () => {
    const f = await fixture();
    f.client.sendTransaction.mockRejectedValueOnce(new Error("response lost"));
    await expect(executeStep(f.options)).rejects.toThrow("response lost");
    const restarted = JSON.parse(JSON.stringify(f.journal)) as SeedJournal;
    await executeStep({ ...f.options, journal: restarted });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.client.sendTransaction).toHaveBeenCalledOnce();
    expect(f.client.waitForTransactionReceipt).toHaveBeenCalledWith(f.hash, {
      timeoutMs: 60_000,
    });
  });

  it("observes a committed transaction without preparing or sending again", async () => {
    const f = await fixture();
    f.recorded();
    f.client.getTransactionReceipt.mockResolvedValue(f.receipt);
    await executeStep(f.options);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  it("replays exactly the saved bytes when unknown and still valid", async () => {
    const f = await fixture();
    f.recorded();
    await executeStep({
      ...f.options,
      client: {
        ...f.client,
        getTransactionStatus: async () => ({ status: "unknown" }),
      },
    });
    expect(f.client.sendTransaction).toHaveBeenCalledWith(f.signed);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("never replaces an expired unknown transaction, even with retry enabled", async () => {
    const f = await fixture();
    f.recorded();
    await expect(
      executeStep({
        ...f.options,
        retryFailed: true,
        client: {
          ...f.client,
          getTransactionStatus: async () => ({ status: "unknown" }),
          getChainTip: async () => ({
            height: blockHeight(101n),
            blockHash: f.hash,
          }),
        },
      }),
    ).rejects.toThrow("Expired unresolved");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  it("retains the original hash on an explicit retry of an authoritative invalid attempt", async () => {
    const f = await fixture();
    const replacement = await fixture(2n);
    f.recorded();
    await executeStep({
      ...f.options,
      retryFailed: true,
      prepare: replacement.prepare,
      client: {
        ...replacement.client,
        getTransactionStatus: async () => ({
          status: "invalid",
          reason: "expired",
        }),
      },
    });
    expect(f.journal.steps[f.name]?.map((attempt) => attempt.hash)).toEqual([
      toHex0x(f.hash),
      toHex0x(replacement.hash),
    ]);
  });

  it("rejects changed intent and corrupted signed hashes", async () => {
    const f = await fixture();
    f.recorded();
    await expect(
      executeStep({ ...f.options, intent: "different recipient" }),
    ).rejects.toThrow("intent changed");
    f.journal.steps[f.name]![0]!.hash = `0x${"00".repeat(32)}`;
    await expect(executeStep(f.options)).rejects.toThrow("hash mismatch");
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  it("requires explicit consent to replace a committed failure", async () => {
    const f = await fixture();
    f.recorded();
    f.client.getTransactionReceipt.mockResolvedValue({
      ...f.receipt,
      execResult: ExecResult.ExecResultTxRootFrameReverted,
    });
    await expect(executeStep(f.options)).rejects.toThrow("SEED_RETRY_FAILED=1");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
    expect(f.journal.steps[f.name]).toHaveLength(1);
  });

  it("rejects a receipt for a different canonical hash", async () => {
    const f = await fixture();
    f.recorded();
    f.client.getTransactionReceipt.mockResolvedValue({
      ...f.receipt,
      txHash: sha256Hash(new Uint8Array(32)),
    });
    await expect(executeStep(f.options)).rejects.toThrow(
      "Receipt hash mismatch",
    );
  });
});

describe("seed local state", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it("durably round-trips original transaction evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seed-journal-"));
    directories.push(directory);
    const f = await fixture();
    f.recorded();
    const path = join(directory, "manifest.json");
    await saveJson(path, f.journal);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(f.journal);
  });

  it("rejects a different network, factory or owner scope", () => {
    expect(() =>
      assertScope("network-a/factory-a/owner-a", "network-b/factory-a/owner-a"),
    ).toThrow("scope mismatch");
    expect(() =>
      assertScope("network-a/factory-a/owner-a", "network-a/factory-b/owner-a"),
    ).toThrow("scope mismatch");
    expect(() =>
      assertScope("network-a/factory-a/owner-a", "network-a/factory-a/owner-b"),
    ).toThrow("scope mismatch");
  });

  it("reads only allowlisted public environment settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seed-env-"));
    directories.push(directory);
    const { writeFile } = await import("node:fs/promises");
    const path = join(directory, ".env.local");
    await writeFile(
      path,
      'PUBLIC_TEST_SETTING="value with spaces"\nPRIVATE_KEY=do-not-load\n',
    );
    expect(await readSeedEnvironment(path, ["PUBLIC_TEST_SETTING"])).toEqual({
      PUBLIC_TEST_SETTING: "value with spaces",
    });
  });
});
