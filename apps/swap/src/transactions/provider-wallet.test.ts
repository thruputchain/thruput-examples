import {
  addressFromBase58,
  hashFromBase58,
  type ThruputClient,
  toBase58,
  type TransactionReceipt,
  TransactionReceiptTimeoutError,
  NativeRpcError,
  JsonRpcError,
  Ed25519Signer,
  createPubkeyAccount,
  createTransaction,
  signTransaction,
  serializeSignedTransaction,
  hashSignedTransaction,
  toHex0x,
} from "@thruputchain/client";
import {
  TransactionExecutionError,
  TransactionObservationError,
  type ProviderWalletClient,
  type ProviderExecutionOptions,
} from "@thruputchain/client/wallet";
import {
  calldata,
  contractEntrypointID,
  ContractType,
  gasAmount,
  blockHeight,
  networkHash,
  sha256Hash,
  type Transaction,
} from "@thruputchain/protocol";
import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/config";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { buildProcessRequestsTarget } from "@/contracts/driver-target";
import { createProviderWriteBoundary } from "./provider-wallet";

const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
// A v2 provider reports identifiers in base58, the form Swap stores.
const config: GlobalConfig = {
  rpcUrl: new URL("http://localhost:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: addressFromBase58(id(0x01)),
  factoryAddress: addressFromBase58(id(0x02)),
  routerAddress: addressFromBase58(id(0x03)),
  nativeTokenAddress: addressFromBase58(id(0x04)),
  poolTokenHash: id(0x05),
};
const target = {
  invoked_address: config.routerAddress,
  entrypoint: contractEntrypointID(new Uint8Array(8)),
  gas_limit: gasAmount(1n),
  calldata: calldata(new Uint8Array()),
};
const signer = new Ed25519Signer(new Uint8Array(32).fill(1));
const account = createPubkeyAccount({ signer });
const signed = await signTransaction(
  createTransaction({
    invocation: target,
    auth_claim: account.authClaim,
    contracts_to_deploy: [],
    uniquifier: { nonce: 1n, block_expiry_height: blockHeight(100n) },
  }),
  account.signers,
  networkHash(sha256Hash(new Uint8Array(32))),
);
const signedBytes = serializeSignedTransaction(signed);
const hash = toBase58(hashSignedTransaction(signed));
const receipt: TransactionReceipt = {
  transactionHash: hashFromBase58(hash),
  blockHeight: blockHeight(11n),
  execution: { result: "return" as const, returnData: new Uint8Array() },
  gasUsed: 0n,
  events: [],
};

function fixture() {
  const pending = {
    hash,
    signedTransaction: toHex0x(signedBytes),
    networkHash: config.networkId,
    account: { address: id(0x01), publicKey: id(0x02), nonce: "0" },
  };
  const wallet = {
    prepareDeployment: vi.fn(),
    deployContractAndWait: vi.fn(),
    executeCallsAndWait: vi.fn(),
    executeAndWait: vi.fn<ProviderWalletClient["executeAndWait"]>(
      async (_request, options) => {
        await options.onSigned(pending);
        return { transactionHash: receipt.transactionHash, receipt };
      },
    ),
    getCapabilities: vi
      .fn()
      .mockResolvedValue({ atomicBatch: { maxCalls: 16 } }),
    prepareBatchExecution: vi.fn().mockResolvedValue({} as Transaction),
    prepareExecution: vi.fn(),
    signTransaction: vi.fn().mockResolvedValue(pending),
    submitTransaction: vi.fn().mockResolvedValue({ hash }),
    dispose: vi.fn(),
  } satisfies ProviderWalletClient;
  const client = {
    getNetworkInfo: vi
      .fn()
      .mockResolvedValue({ networkHash: new Uint8Array(32) }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
  };
  const artifact = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: new Uint8Array([1]) },
  } as const;
  const loadArtifact = vi.fn().mockResolvedValue(artifact);
  const boundary = createProviderWriteBoundary(
    config,
    client as unknown as ThruputClient,
    wallet,
    { loadArtifact },
  );
  return { wallet, client, boundary, artifact, loadArtifact };
}

describe("provider write boundary", () => {
  it("keeps the calibrated crank frame and enclosing wallet budget", async () => {
    const { boundary, wallet } = fixture();
    const invocation = buildProcessRequestsTarget(addressFromBase58(id(0x06)));
    expect(invocation.gas_limit).toBeGreaterThan(200_000n + 8n * 1_500_000n);
    expect((await boundary.execute(invocation)).kind).toBe("committedSuccess");
    expect(wallet.executeAndWait).toHaveBeenCalledWith(
      { invocation, gasLimit: 18_700_000n, expiryBlocks: 1_000n },
      expect.anything(),
    );
  });

  it("delegates single execution and forwards durable persistence to the SDK", async () => {
    const { boundary, wallet } = fixture();
    const onSigned = vi.fn();
    expect(await boundary.execute(target, { onSigned })).toMatchObject({
      kind: "committedSuccess",
      hash,
      receipt,
    });
    expect(onSigned).toHaveBeenCalledExactlyOnceWith(hash);
    expect(wallet.prepareExecution).not.toHaveBeenCalled();
    expect(wallet.submitTransaction).not.toHaveBeenCalled();
    const controls: ProviderExecutionOptions =
      wallet.executeAndWait.mock.calls[0]![1];
    expect(controls.wait).toMatchObject({
      expectedNetworkHash: new Uint8Array(32),
      timeoutMs: 20_000,
    });
  });

  it("rejects wrong read networks and artifact mismatches before asking the wallet", async () => {
    const { boundary, wallet, client, loadArtifact } = fixture();
    client.getNetworkInfo.mockResolvedValueOnce({
      networkHash: new Uint8Array(32).fill(1),
    });
    expect((await boundary.execute(target)).kind).toBe("preSubmissionFailure");
    loadArtifact.mockRejectedValue(new Error("hash mismatch"));
    expect(
      (
        await boundary.execute({
          ...target,
          invoked_address: config.factoryAddress,
          entrypoint: SwapFactory.v0_1.createPair.entrypoint,
        })
      ).kind,
    ).toBe("preSubmissionFailure");
    expect(wallet.executeAndWait).not.toHaveBeenCalled();
  });

  it("attaches code only to the configured factory createPair", async () => {
    const { boundary, wallet, loadArtifact, artifact } = fixture();
    await boundary.execute({
      ...target,
      invoked_address: config.factoryAddress,
      entrypoint: SwapFactory.v0_1.createPair.entrypoint,
    });
    expect(wallet.executeAndWait.mock.calls[0]![0].contractsToDeploy).toEqual([
      artifact,
    ]);
    await boundary.execute({
      ...target,
      entrypoint: SwapFactory.v0_1.createPair.entrypoint,
    });
    expect(
      wallet.executeAndWait.mock.calls[1]![0].contractsToDeploy,
    ).toBeUndefined();
    expect(loadArtifact).toHaveBeenCalledExactlyOnceWith(config.poolTokenHash);
  });

  it.each([false, true])(
    "awaits persistence before broadcasting raw batches (failure=%s)",
    async (failure) => {
      const { boundary, wallet, client } = fixture();
      let release!: () => void;
      const onSigned = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (failure) throw new Error("storage full");
      });
      const result = boundary.executeBatch!([target, target], { onSigned });
      await vi.waitFor(() => expect(onSigned).toHaveBeenCalledOnce());
      expect(wallet.submitTransaction).not.toHaveBeenCalled();
      release();
      expect((await result).kind).toBe(
        failure ? "preSubmissionFailure" : "committedSuccess",
      );
      expect(wallet.submitTransaction).toHaveBeenCalledTimes(failure ? 0 : 1);
      expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(
        failure ? 0 : 1,
      );
      expect(wallet.prepareBatchExecution.mock.calls[0]![0].gasLimit).toBe(
        5_000_002n,
      );
    },
  );

  it("observes the original batch hash after ambiguous submit without re-signing", async () => {
    const { boundary, wallet, client } = fixture();
    wallet.submitTransaction.mockRejectedValue(
      new Error("lost acknowledgement"),
    );
    expect((await boundary.executeBatch!([target, target])).kind).toBe(
      "committedSuccess",
    );
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(
      receipt.transactionHash,
      expect.anything(),
    );
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(wallet.submitTransaction).toHaveBeenCalledOnce();
  });

  it("retains committed failure and uncertain submission evidence", async () => {
    const { boundary, wallet } = fixture();
    wallet.executeAndWait.mockRejectedValueOnce(
      new TransactionExecutionError({
        ...receipt,
        execution: { result: "abort" as const, abortData: new Uint8Array() },
      }),
    );
    expect(await boundary.execute(target)).toMatchObject({
      kind: "committedFailure",
      hash,
    });
    wallet.executeAndWait.mockRejectedValueOnce(
      new TransactionObservationError(
        {
          signedTransaction: signedBytes,
          transactionHash: receipt.transactionHash,
          networkHash: new Uint8Array(32),
        },
        new TransactionReceiptTimeoutError(
          receipt.transactionHash,
          undefined,
          undefined,
        ),
      ),
    );
    expect(await boundary.execute(target)).toEqual({
      kind: "indeterminate",
      hash,
      reason: "timeout",
    });
  });

  it("recovers through public RPC while disconnected, pinned to the original network", async () => {
    const { client } = fixture();
    const boundary = createProviderWriteBoundary(
      config,
      client as unknown as ThruputClient,
    );
    expect((await boundary.execute(target)).kind).toBe("preSubmissionFailure");
    expect(await boundary.observe!(hash)).toMatchObject({
      kind: "committedSuccess",
      hash,
      receipt,
    });
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(
      receipt.transactionHash,
      expect.objectContaining({ expectedNetworkHash: new Uint8Array(32) }),
    );
    expect((await boundary.observe!("invalid")).kind).toBe(
      "preSubmissionFailure",
    );
    expect(client.waitForTransactionReceipt).toHaveBeenCalledOnce();
    client.waitForTransactionReceipt.mockRejectedValueOnce(
      new NativeRpcError(
        new JsonRpcError(-32000, "expired", {
          kind: "transactionInvalid",
          admission: "notAttempted",
        }),
        "sendTransaction",
        receipt.transactionHash,
      ),
    );
    expect(await boundary.observe!(hash)).toEqual({
      kind: "invalid",
      hash,
      reason: "expired",
    });
  });
});
