import {
  addressFromHex,
  hashFromHex,
  type GroundhogClient,
} from "@groundhogchain/client";
import {
  calldata,
  contractEntrypointID,
  ContractType,
  ExecResult,
  gasAmount,
  type Transaction,
} from "@groundhogchain/protocol";
import type { ProviderWalletClient } from "@groundhogchain/client/wallet";
import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/config";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { buildProcessRequestsTarget } from "@/contracts/driver-target";
import { createProviderWriteBoundary } from "./provider-wallet";

const hex = (byte: string) => `0x${byte.repeat(32)}`;
const hash = hex("ab");
const config: GlobalConfig = {
  rpcUrl: new URL("http://localhost:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: addressFromHex(hex("01")),
  factoryAddress: addressFromHex(hex("02")),
  routerAddress: addressFromHex(hex("03")),
  nativeHogAddress: addressFromHex(hex("04")),
  poolTokenHash: hex("05"),
};
const target = {
  invoked_address: config.routerAddress,
  entrypoint: contractEntrypointID(new Uint8Array(8)),
  gas_limit: gasAmount(1n),
  calldata: calldata(new Uint8Array()),
};
const receipt = {
  txHash: hashFromHex(hash),
  height: 11n,
  execResult: ExecResult.ExecResultOK,
  events: [],
  returnData: new Uint8Array(),
  abortData: null,
};

function fixture() {
  const wallet = {
    prepareExecution: vi.fn().mockResolvedValue({} as Transaction),
    signTransaction: vi
      .fn()
      .mockResolvedValue({ signedTransaction: "0x00", hash }),
    submitTransaction: vi.fn().mockResolvedValue({ hash }),
    dispose: vi.fn(),
  } satisfies ProviderWalletClient;
  const client = {
    getNetworkInfo: vi
      .fn()
      .mockResolvedValue({ networkHash: new Uint8Array(32) }),
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    getTransactionStatus: vi.fn().mockResolvedValue({ status: "pending" }),
    sendTransaction: vi.fn(),
  };
  const artifact = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: new Uint8Array([1]) },
  } as const;
  const loadArtifact = vi.fn().mockResolvedValue(artifact);
  const boundary = createProviderWriteBoundary(
    config,
    client as unknown as GroundhogClient,
    wallet,
    { maxPolls: 2, delay: async () => {}, loadArtifact },
  );
  return { wallet, client, boundary, loadArtifact, artifact };
}

describe("provider write boundary", () => {
  it("funds the crank frame and enclosing wallet transaction for an eight-request batch", async () => {
    const { wallet, boundary } = fixture();
    const invocation = buildProcessRequestsTarget(addressFromHex(hex("06")));
    // `budget_for_batch(8)`: EPILOGUE_GAS + 8 * REQUEST_GAS_MAX. A crank that
    // declares less than this is refused outright when eight or more requests
    // are waiting, so the frame has to clear it.
    const batchFloor = 200_000n + 8n * 1_500_000n;
    expect(invocation.gas_limit).toBeGreaterThan(batchFloor);
    await expect(boundary.execute(invocation)).resolves.toMatchObject({
      kind: "committedSuccess",
    });
    expect(wallet.prepareExecution).toHaveBeenCalledWith({
      invocation,
      gasLimit: 18_700_000n,
      expiryBlocks: 1_000n,
    });
    expect(18_700_000n - invocation.gas_limit).toBe(5_000_000n);
  });

  it("does not prepare a transaction against a different RPC network", async () => {
    const { client, wallet, boundary } = fixture();
    client.getNetworkInfo.mockResolvedValue({
      networkHash: new Uint8Array(32).fill(1),
    });
    await expect(boundary.execute(target)).resolves.toMatchObject({
      kind: "preSubmissionFailure",
    });
    expect(wallet.prepareExecution).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("keeps the original hash unresolved when the RPC network changes during recovery", async () => {
    const { client, boundary } = fixture();
    client.getNetworkInfo.mockResolvedValue({
      networkHash: new Uint8Array(32).fill(1),
    });
    client.getTransactionReceipt.mockResolvedValue(null);
    client.getTransactionStatus.mockResolvedValue({
      status: "invalid",
      reason: "expired",
    });
    await expect(boundary.observe!(hash)).resolves.toMatchObject({
      kind: "indeterminate",
      hash,
    });
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(client.getTransactionStatus).not.toHaveBeenCalled();
  });
  it("awaits durable hash persistence before submitting approved bytes, then observes via public RPC", async () => {
    const { wallet, client, boundary, loadArtifact } = fixture();
    let persisted!: () => void;
    const onSigned = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          persisted = resolve;
        }),
    );
    const execution = boundary.execute(target, { onSigned });
    await vi.waitFor(() => expect(onSigned).toHaveBeenCalledWith(hash));
    expect(wallet.submitTransaction).not.toHaveBeenCalled();
    persisted();
    await expect(execution).resolves.toMatchObject({
      kind: "committedSuccess",
      hash,
    });
    expect(wallet.prepareExecution).toHaveBeenCalledWith({
      invocation: target,
      gasLimit: 10_000_000n,
      expiryBlocks: 1_000n,
    });
    expect(wallet.submitTransaction).toHaveBeenCalledWith({
      signedTransaction: "0x00",
      hash,
    });
    expect(client.sendTransaction).not.toHaveBeenCalled();
    expect(loadArtifact).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "never submits when the persistence callback fails (async=%s)",
    async (asyncFailure) => {
      const { wallet, boundary } = fixture();
      const onSigned = () => {
        if (asyncFailure) return Promise.reject(new Error("storage failed"));
        throw new Error("storage failed");
      };
      await expect(
        boundary.execute(target, { onSigned }),
      ).resolves.toMatchObject({
        kind: "preSubmissionFailure",
        message: "storage failed",
      });
      expect(wallet.submitTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(["prepareExecution", "signTransaction"] as const)(
    "does not submit after %s fails",
    async (method) => {
      const { wallet, boundary } = fixture();
      wallet[method].mockRejectedValue(new Error("Rejected"));
      await expect(boundary.execute(target)).resolves.toMatchObject({
        kind: "preSubmissionFailure",
      });
      expect(wallet.submitTransaction).not.toHaveBeenCalled();
    },
  );

  it("attaches the LP artifact only to the configured factory's createPair", async () => {
    const { wallet, boundary, loadArtifact, artifact } = fixture();
    const creation = {
      ...target,
      invoked_address: config.factoryAddress,
      entrypoint: SwapFactory.createPair.entrypoint,
    };
    await boundary.execute(creation);
    expect(loadArtifact).toHaveBeenCalledWith(config.poolTokenHash);
    expect(wallet.prepareExecution).toHaveBeenLastCalledWith({
      invocation: creation,
      gasLimit: 10_000_000n,
      expiryBlocks: 1_000n,
      contractsToDeploy: [artifact],
    });
    await boundary.execute({
      ...creation,
      invoked_address: config.routerAddress,
    });
    await boundary.execute({
      ...target,
      invoked_address: config.factoryAddress,
    });
    expect(loadArtifact).toHaveBeenCalledTimes(1);
    expect(wallet.prepareExecution.mock.calls[1]?.[0]).not.toHaveProperty(
      "contractsToDeploy",
    );
    expect(wallet.prepareExecution.mock.calls[2]?.[0]).not.toHaveProperty(
      "contractsToDeploy",
    );
  });

  it("artifact failure happens before preparation or signing", async () => {
    const { wallet, boundary, loadArtifact } = fixture();
    loadArtifact.mockRejectedValue(new Error("hash mismatch"));
    await expect(
      boundary.execute({
        ...target,
        invoked_address: config.factoryAddress,
        entrypoint: SwapFactory.createPair.entrypoint,
      }),
    ).resolves.toMatchObject({
      kind: "preSubmissionFailure",
      message: "hash mismatch",
    });
    expect(wallet.prepareExecution).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("observes the original hash after ambiguous submit failure without re-signing", async () => {
    const { wallet, client, boundary } = fixture();
    wallet.submitTransaction.mockRejectedValue(new Error("disconnected"));
    client.getTransactionReceipt.mockRejectedValue(new Error("offline"));
    await expect(boundary.execute(target)).resolves.toEqual({
      kind: "indeterminate",
      hash,
      reason: "disconnect",
    });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith(
      hashFromHex(hash),
    );
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("can recover a committed receipt even when submission threw", async () => {
    const { wallet, boundary } = fixture();
    wallet.submitTransaction.mockRejectedValue(
      new Error("lost acknowledgement"),
    );
    await expect(boundary.execute(target)).resolves.toMatchObject({
      kind: "committedSuccess",
      hash,
    });
  });

  it("observes the approved hash when the SDK rejects a submission hash mismatch", async () => {
    const { wallet, client, boundary } = fixture();
    wallet.submitTransaction.mockRejectedValue(
      new Error(
        "Provider submission hash mismatch; broadcast may have occurred",
      ),
    );
    await expect(boundary.execute(target)).resolves.toMatchObject({
      kind: "committedSuccess",
      hash,
    });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith(
      hashFromHex(hash),
    );
  });

  it("observes signed requests while disconnected, but refuses new writes", async () => {
    const { client } = fixture();
    const boundary = createProviderWriteBoundary(
      config,
      client as unknown as GroundhogClient,
    );
    await expect(boundary.execute(target)).resolves.toMatchObject({
      kind: "preSubmissionFailure",
    });
    await expect(boundary.observe?.(hash)).resolves.toMatchObject({
      kind: "committedSuccess",
      hash,
    });
    await expect(boundary.observe?.("invalid")).resolves.toMatchObject({
      kind: "preSubmissionFailure",
    });
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it("tolerates a transient polling failure and a temporarily unknown status", async () => {
    const { client, boundary } = fixture();
    client.getTransactionReceipt.mockRejectedValueOnce(new Error("offline"));
    await expect(boundary.observe?.(hash)).resolves.toMatchObject({
      kind: "committedSuccess",
    });
    client.getTransactionReceipt.mockResolvedValueOnce(null);
    client.getTransactionStatus.mockResolvedValue({ status: "unknown" });
    await expect(boundary.observe?.(hash)).resolves.toMatchObject({
      kind: "committedSuccess",
    });
  });

  it("requires a matching receipt and distinguishes committed failure from invalid status", async () => {
    const { client, boundary } = fixture();
    client.getTransactionReceipt.mockResolvedValueOnce({
      ...receipt,
      txHash: hashFromHex(hex("ff")),
    });
    await expect(boundary.observe?.(hash)).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "other",
    });
    client.getTransactionReceipt.mockResolvedValueOnce({
      ...receipt,
      execResult: 1,
    });
    await expect(boundary.observe?.(hash)).resolves.toMatchObject({
      kind: "committedFailure",
    });
    client.getTransactionReceipt.mockResolvedValue(null);
    client.getTransactionStatus.mockResolvedValue({
      status: "invalid",
      reason: "expired",
    });
    await expect(boundary.observe?.(hash)).resolves.toMatchObject({
      kind: "invalid",
      reason: "expired",
    });
  });
});
