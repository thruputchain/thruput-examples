import {
  deserializeTransaction,
  fromHex0x,
  toHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import {
  AuthClaimType,
  calldata,
  contractAddress,
  contractEntrypointID,
  ExecResult,
  gasAmount,
  sha256Hash,
} from "@groundhogchain/protocol";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import {
  canonicalTransactionHash,
  createLocalWriteBoundary,
  wrapTargetInvocation,
} from "./local-development-wallet";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: 0n,
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  pairAddress: address(3),
  handlerAddress: address(4),
  driverAddress: address(5),
  tokenAAddress: address(6),
  tokenBAddress: address(7),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenDecimals: 6,
};
const target = {
  invoked_address: address(8),
  entrypoint: contractEntrypointID(new Uint8Array(8).fill(9)),
  gas_limit: gasAmount(10n),
  calldata: calldata(new Uint8Array([1, 2, 3])),
};
const wallet = {
  privateKeyHex: `0x${"01".repeat(32)}`,
  walletEntrypointHex: `0x${"02".repeat(8)}`,
};

describe("local development wallet encoding", () => {
  it("matches the Rust doAction CXS fixture", () => {
    const wrapped = wrapTargetInvocation(
      contractAddress(new Uint8Array(32).fill(0x11)),
      contractEntrypointID(new TextEncoder().encode("doAction")),
      {
        invoked_address: contractAddress(new Uint8Array(32).fill(0x22)),
        entrypoint: contractEntrypointID(new TextEncoder().encode("transfer")),
        gas_limit: gasAmount(124n),
        calldata: calldata(new TextEncoder().encode("payload")),
      },
    );

    expect(toHex0x(wrapped.calldata)).toBe(
      "0x3c22222222222222222222222222222222222222222222222222222222222222227472616e73666572000000000000007c000000077061796c6f616400",
    );
  });

  it("matches the node's unsigned-transaction hash vector", () => {
    const transaction = deserializeTransaction(
      fromHex0x(
        "0xbc10f38522c4e14265a1483af9e5375f5dea0e2c6bf25727ee8b429bf3c1a9b7000000000000000000000000000f42400000000000000000000f4240000000000000000100000000000000010000000050ec72dbafd4898c5df0e15ea6ba3e46240945b7210fe2d63dde1e896f42107a0000000000000000",
      ),
    );

    expect(toHex0x(canonicalTransactionHash(transaction))).toBe(
      "0x9dc7ad0fc4f74a43a62e047c0d6885c8e4df2d4840298ecd52cf157681157ed3",
    );
  });

  it("signs, submits, verifies the RPC hash, and returns a committed receipt", async () => {
    const onSigned = vi.fn();
    const sendTransaction = vi.fn(async (signed) => {
      expect(onSigned).toHaveBeenCalledWith(expect.stringMatching(/^0x[0-9a-f]{64}$/));
      expect(signed.tx.invocation.invoked_address).toEqual(config.accountAddress);
      expect(signed.tx.auth_claim.claim_type).toBe(
        AuthClaimType.kSourceAddressAuthData,
      );
      return canonicalTransactionHash(signed.tx);
    });
    const txHash = sha256Hash(new Uint8Array(32).fill(3));
    const client = {
      getChainTip: vi.fn().mockResolvedValue({ height: 10n, blockHash: txHash }),
      sendTransaction,
      getTransactionReceipt: vi.fn().mockImplementation(async (hash) => ({
        txHash: hash,
        height: 11n,
        execResult: ExecResult.ExecResultOK,
        events: [],
        returnData: new Uint8Array(),
        abortData: null,
      })),
      getTransactionStatus: vi.fn(),
    } as unknown as GroundhogClient;
    const boundary = createLocalWriteBoundary(config, wallet, {
      client,
      nonce: () => 7n,
    });

    await expect(boundary.execute(target, { onSigned })).resolves.toMatchObject({
      kind: "committedSuccess",
      receipt: { height: 11n },
    });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("preserves the local hash after an ambiguous submission disconnect", async () => {
    const txHash = sha256Hash(new Uint8Array(32).fill(3));
    const client = {
      getChainTip: vi.fn().mockResolvedValue({ height: 10n, blockHash: txHash }),
      sendTransaction: vi.fn().mockRejectedValue(new Error("connection reset")),
    } as unknown as GroundhogClient;
    const boundary = createLocalWriteBoundary(config, wallet, {
      client,
      nonce: () => 7n,
    });

    const result = await boundary.execute(target);

    expect(result).toMatchObject({ kind: "indeterminate", reason: "disconnect" });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects writes to a non-loopback endpoint before signing", async () => {
    const boundary = createLocalWriteBoundary(
      { ...config, rpcUrl: new URL("https://rpc.example.com") },
      wallet,
    );

    await expect(boundary.execute(target)).resolves.toMatchObject({
      kind: "preSubmissionFailure",
      hash: null,
    });
  });

  it("rejects signing when the application page is not loopback", async () => {
    vi.stubGlobal("window", { location: { hostname: "app.example.com" } });
    try {
      const boundary = createLocalWriteBoundary(config, wallet);

      await expect(boundary.execute(target)).resolves.toMatchObject({
        kind: "preSubmissionFailure",
        hash: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats a mismatched receipt hash as indeterminate", async () => {
    const blockHash = sha256Hash(new Uint8Array(32).fill(3));
    const client = {
      getChainTip: vi.fn().mockResolvedValue({ height: 10n, blockHash }),
      sendTransaction: vi.fn().mockImplementation(async (signed) =>
        canonicalTransactionHash(signed.tx)),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        txHash: sha256Hash(new Uint8Array(32).fill(4)),
        height: 11n,
        execResult: ExecResult.ExecResultOK,
        events: [],
        returnData: new Uint8Array(),
        abortData: null,
      }),
    } as unknown as GroundhogClient;

    await expect(
      createLocalWriteBoundary(config, wallet, { client, nonce: () => 7n })
        .execute(target),
    ).resolves.toMatchObject({ kind: "indeterminate", reason: "other" });
  });

  it("returns an authoritative invalid outcome without retrying", async () => {
    const blockHash = sha256Hash(new Uint8Array(32).fill(3));
    const client = {
      getChainTip: vi.fn().mockResolvedValue({ height: 10n, blockHash }),
      sendTransaction: vi.fn().mockImplementation(async (signed) =>
        canonicalTransactionHash(signed.tx)),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransactionStatus: vi.fn().mockResolvedValue({
        status: "invalid",
        reason: "expired",
      }),
    } as unknown as GroundhogClient;

    await expect(
      createLocalWriteBoundary(config, wallet, { client, nonce: () => 7n })
        .execute(target),
    ).resolves.toMatchObject({ kind: "invalid", reason: "expired" });
  });
});
