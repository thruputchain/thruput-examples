import {
  hashFromBase58,
  hashSignedTransaction,
  PrivateKeySigner,
  signTransaction,
  toHex0x,
  TransactionReceiptTimeoutError,
  NativeRpcError,
  JsonRpcError,
  type ThruputClient,
  type TransactionReceipt,
  toBase58,
} from "@thruputchain/client";
import { DefaultWallet } from "@thruputchain/client/contracts";
import {
  parseTransactionHex,
  type ProviderRequest,
  type WalletProvider,
  type WalletSession,
} from "@thruputchain/client/provider";
import {
  createPubkeyAccount,
  createProviderWalletClient,
} from "@thruputchain/client/wallet";
import {
  blockHeight,
  calldata,
  codec,
  contractAddress,
  contractEntrypointID,
  ContractType,
  gasAmount,
  networkHash,
  serialize,
  sha256Hash,
} from "@thruputchain/protocol";
import { CxsWriter } from "@thruputchain/xdr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/config";
import { StandardTokenFactory } from "@/contracts/generated/standard-token-factory";
import { createProviderWriteBoundary } from "./provider-wallet";
import { createTransactionObserver } from "./transaction-observation";
import { hashContract } from "@thruputchain/client";

const config = loadConfig({
  VITE_THRUPUT_RPC_URL: "http://localhost:9545",
  VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(0xab)),
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: toBase58(new Uint8Array(32).fill(0x04)),
  VITE_NATIVE_HOG_ADDRESS: toBase58(new Uint8Array(32).fill(0x05)),
  VITE_STANDARD_TOKEN_HASH: toBase58(new Uint8Array(32).fill(0x06)),
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
});
const target = {
  method: StandardTokenFactory.v0_1.createToken,
  invocation: {
    invoked_address: contractAddress(new Uint8Array(32).fill(9)),
    entrypoint: contractEntrypointID(new Uint8Array(8)),
    gas_limit: gasAmount(1000n),
    calldata: calldata(new Uint8Array()),
  },
};
const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
const localAccount = createPubkeyAccount({ signer, nonce: 7n });
const account = {
  address: toBase58(localAccount.address),
  publicKey: toBase58(signer.publicKey.ed25519),
  nonce: "7",
};
const signingNetwork = networkHash(hashFromBase58(config.networkId));
const childReturn = new Uint8Array(32).fill(8);
const returnWriter = new CxsWriter();
returnWriter.writeUint32(1n);
returnWriter.writeVarOpaque(childReturn, 0xffff_ffff);
const wrappedReturn = returnWriter.finish();

function setup() {
  let session: WalletSession = {
    networkHash: config.networkId,
    accounts: [account],
  };
  const listeners = new Set<(session: WalletSession) => void>();
  let canonicalHash = "";
  const request = vi.fn(async (input: ProviderRequest): Promise<unknown> => {
    if (input.method === "getSession" || input.method === "connect")
      return session;
    if (input.method === "signTransaction") {
      const tx = parseTransactionHex(input.params.transaction);
      expect(tx.invocation.entrypoint).toEqual(
        DefaultWallet.v0_1.execute.entrypoint,
      );
      expect(tx.auth_claim).toEqual(localAccount.authClaim);
      expect(tx.uniquifier.block_expiry_height).toBe(1_010n);
      const signed = await signTransaction(
        tx,
        localAccount.signers,
        signingNetwork,
      );
      canonicalHash = toBase58(hashSignedTransaction(signed));
      return {
        signedTransaction: toHex0x(serialize(signed, codec.SignedTransaction)),
        hash: canonicalHash,
      };
    }
    if (input.method === "submitTransaction") return { hash: canonicalHash };
    return null;
  });
  const provider: WalletProvider = {
    info: { id: "test", name: "Test Wallet", version: "2.0.0" },
    request,
    on(_event, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const receipt = (hash: Uint8Array): TransactionReceipt => ({
    transactionHash: sha256Hash(hash),
    blockHeight: blockHeight(11n),
    execution: { result: "return" as const, returnData: wrappedReturn },
    gasUsed: 0n,
    events: [],
  });
  const client = {
    requireMethods: vi.fn(),
    discovery: { network: { networkHash: signingNetwork } },
    getNetworkInfo: vi.fn().mockResolvedValue({ networkHash: signingNetwork }),
    getChainTip: vi.fn().mockResolvedValue({ blockHeight: 10n }),
    getTransactionReceipt: vi.fn(
      async ({ transactionHash }: { transactionHash: Uint8Array }) =>
        receipt(transactionHash),
    ),
    getTransactionStatus: vi.fn().mockResolvedValue({ status: "unknown" }),
    waitForTransactionReceipt: vi.fn(async (hash: Uint8Array) => receipt(hash)),
    sendTransaction: vi.fn(),
  };
  const wallet = createProviderWalletClient({
    client: client as unknown as ThruputClient,
    provider,
    account,
    networkHash: config.networkId,
  });
  const boundary = {
    ...createProviderWriteBoundary(
      config,
      client as unknown as ThruputClient,
      wallet,
    ),
    dispose: () => wallet.dispose(),
  };
  return {
    boundary,
    request,
    client,
    provider,
    receipt,
    change(next: WalletSession) {
      session = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("provider write boundary with the real SDK", () => {
  it("preserves committed failure without trying to decode child return bytes", async () => {
    const { boundary, client } = setup();
    client.waitForTransactionReceipt.mockImplementationOnce(async (hash) => ({
      transactionHash: sha256Hash(hash),
      blockHeight: blockHeight(11n),
      execution: { result: "abort" as const, abortData: new Uint8Array([1]) },
      gasUsed: 0n,

      events: [],
    }));
    try {
      expect(await boundary.execute(target, { onSigned() {} })).toMatchObject({
        kind: "committedFailure",
      });
    } finally {
      boundary.dispose();
    }
  });

  it("retains the original successful receipt when child decoding fails", async () => {
    const { boundary, client } = setup();
    client.waitForTransactionReceipt.mockImplementationOnce(async (hash) => ({
      transactionHash: sha256Hash(hash),
      blockHeight: blockHeight(11n),
      execution: { result: "return" as const, returnData: new Uint8Array([1]) },
      gasUsed: 0n,

      events: [],
    }));
    try {
      const result = await boundary.execute(target, { onSigned() {} });
      expect(result).toMatchObject({
        kind: "committedSuccess",
        receipt: {
          execution: { result: "return", returnData: new Uint8Array([1]) },
        },
      });
    } finally {
      boundary.dispose();
    }
  });

  it("keeps the adapter usable after approval timeout and signs a fresh transaction on retry", async () => {
    const { boundary, request, client } = setup();
    const original = request.getMockImplementation()!;
    let timeOut = true;
    request.mockImplementation(async (input) => {
      if (input.method === "signTransaction" && timeOut) {
        timeOut = false;
        throw Object.assign(new Error("Approval timed out"), { code: 4001 });
      }
      return original(input);
    });
    const onSigned = vi.fn();
    expect(await boundary.execute(target, { onSigned })).toMatchObject({
      kind: "preSubmissionFailure",
      hash: null,
      message: expect.stringContaining("Try again"),
    });
    expect(onSigned).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(
        ([input]) => input.method === "submitTransaction",
      ),
    ).toBe(false);
    expect((await boundary.execute(target, { onSigned })).kind).toBe(
      "committedSuccess",
    );
    expect(client.getChainTip).toHaveBeenCalledTimes(2);
    expect(onSigned).toHaveBeenCalledOnce();
    boundary.dispose();
  });

  it.each([4100, 4900, 4901])(
    "reports invalidated signing clients on provider error %s",
    async (code) => {
      const { boundary, request } = setup();
      request.mockRejectedValueOnce(
        Object.assign(new Error("Wallet unavailable"), { code }),
      );
      expect(
        await boundary.execute(target, { onSigned: vi.fn() }),
      ).toMatchObject({
        kind: "preSubmissionFailure",
      });
      boundary.dispose();
    },
  );

  it("awaits persistence, submits only through the provider, and preserves the root receipt", async () => {
    const { boundary, request, client } = setup();
    let persist!: () => void;
    const barrier = new Promise<void>((resolve) => {
      persist = resolve;
    });
    const onSigned = vi.fn((_hash: string) => barrier);
    const execution = boundary.execute(target, { onSigned });
    await vi.waitFor(() => expect(onSigned).toHaveBeenCalledOnce());
    expect(
      request.mock.calls.some(
        ([input]) => input.method === "submitTransaction",
      ),
    ).toBe(false);
    persist();
    const result = await execution;
    expect(result.kind).toBe("committedSuccess");
    if (result.kind !== "committedSuccess") throw new Error("Expected commit");
    expect(result.hash).toBe(onSigned.mock.calls[0]![0]);
    expect(result.receipt.execution).toEqual({
      result: "return",
      returnData: wrappedReturn,
    });
    expect(toBase58(result.receipt.transactionHash)).toBe(result.hash);
    expect(result.receipt.events).toEqual([]);
    expect(client.sendTransaction).not.toHaveBeenCalled();
    boundary.dispose();
    expect((await boundary.observe(result.hash)).kind).toBe("committedSuccess");
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === "signTransaction",
      ),
    ).toHaveLength(1);
  });

  it.each(["sync", "async"])(
    "never broadcasts after %s persistence failure",
    async (mode) => {
      const { boundary, request, client } = setup();
      const result = await boundary.execute(target, {
        onSigned() {
          if (mode === "sync") throw new Error("Storage full");
          return Promise.reject(new Error("Storage full"));
        },
      });
      expect(result.kind).toBe("indeterminate");
      expect(
        request.mock.calls.some(
          ([input]) => input.method === "submitTransaction",
        ),
      ).toBe(false);
      expect(client.sendTransaction).not.toHaveBeenCalled();
      boundary.dispose();
    },
  );

  it("observes the canonical hash after ambiguous submit and never re-signs a retry", async () => {
    const { boundary, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input) => {
      if (input.method === "submitTransaction")
        throw new Error("Disconnected after broadcast");
      return original(input);
    });
    const onSigned = vi.fn();
    const result = await boundary.execute(target, { onSigned });
    expect(result).toMatchObject({
      kind: "committedSuccess",
      hash: onSigned.mock.calls[0]![0],
    });
    await boundary.observe(onSigned.mock.calls[0]![0]);
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === "signTransaction",
      ),
    ).toHaveLength(1);
    boundary.dispose();
  });

  it("recovers the approved hash when the SDK rejects a provider submission hash mismatch", async () => {
    const { boundary, request, client } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input) =>
      input.method === "submitTransaction"
        ? { hash: toBase58(new Uint8Array(32).fill(0xff)) }
        : original(input),
    );
    const onSigned = vi.fn();
    try {
      const result = await boundary.execute(target, { onSigned });
      expect(result).toMatchObject({
        kind: "committedSuccess",
        hash: onSigned.mock.calls[0]![0],
      });
      expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(
        hashFromBase58(onSigned.mock.calls[0]![0]),
        expect.objectContaining({ expectedNetworkHash: signingNetwork }),
      );
    } finally {
      boundary.dispose();
    }
  });

  it("invalidates a pending old adapter on account change but keeps polling independent", async () => {
    const { boundary, change, request } = setup();
    const result = await boundary.execute(target, {
      onSigned() {
        change({ networkHash: config.networkId, accounts: [] });
      },
    });
    expect(result.kind).toBe("indeterminate");
    expect(
      request.mock.calls.some(
        ([input]) => input.method === "submitTransaction",
      ),
    ).toBe(false);
    expect((await boundary.execute(target, { onSigned() {} })).kind).toBe(
      "preSubmissionFailure",
    );
    boundary.dispose();
  });

  it("attaches verified code only to factory create_token and rejects mismatches before signing", async () => {
    const { provider, client, request, boundary } = setup();
    const contract = {
      contract_type: ContractType.kRv32,
      rv32_contract: { data: new Uint8Array([1, 2, 3]) },
    } as const;
    const hash = hashContract(contract);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            contractType: "rv32",
            data: "0x010203",
            hash: toBase58(hash),
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const wallet = createProviderWalletClient({
      client: client as unknown as ThruputClient,
      provider,
      account,
      networkHash: config.networkId,
    });
    const writer = createProviderWriteBoundary(
      { ...config, expectedTokenHash: hash },
      client as unknown as ThruputClient,
      wallet,
    );
    await writer.execute(target, { onSigned() {} });
    expect(fetch).not.toHaveBeenCalled();
    const creation = {
      ...target,
      invocation: {
        ...target.invocation,
        invoked_address: config.factoryAddress,
        entrypoint: StandardTokenFactory.v0_1.createToken.entrypoint,
      },
    };
    await writer.execute(creation, { onSigned() {} });
    expect(fetch).toHaveBeenCalledOnce();
    const signCalls = request.mock.calls.filter(
      ([input]) => input.method === "signTransaction",
    );
    const input = signCalls[1]![0];
    if (input.method !== "signTransaction") throw new Error("Expected signing");
    expect(
      parseTransactionHex(input.params.transaction).contracts_to_deploy,
    ).toEqual([contract]);
    request.mockClear();
    expect((await boundary.execute(creation, { onSigned() {} })).kind).toBe(
      "preSubmissionFailure",
    );
    expect(request).not.toHaveBeenCalled();
    wallet.dispose();
    boundary.dispose();
  });

  it.each(["invalid", "unknown", "recentFailure"])(
    "preserves %s observation evidence",
    async (status) => {
      const { client, boundary } = setup();
      const hash = sha256Hash(new Uint8Array(32).fill(1));
      client.waitForTransactionReceipt.mockRejectedValue(
        status === "invalid"
          ? new NativeRpcError(
              new JsonRpcError(-32000, "Rejected", {
                kind: "transactionInvalid",
                admission: "notAttempted",
              }),
              "sendTransaction",
              hash,
            )
          : new TransactionReceiptTimeoutError(
              hash,
              undefined,
              status === "recentFailure"
                ? {
                    status,
                    attemptBlockHeight: blockHeight(1n),
                    cause: {
                      kind: "dbConflict",
                      conflict: {
                        code: "exclusiveLock",
                        address: target.invocation.invoked_address,
                        key: new Uint8Array(32),
                      },
                    },
                  }
                : { status: "unknown" },
            ),
      );
      const observe = createTransactionObserver(
        config,
        client as unknown as ThruputClient,
      );
      expect(
        await observe(toBase58(new Uint8Array(32).fill(0x01))),
      ).toMatchObject(
        status === "invalid"
          ? { kind: "invalid", reason: "Rejected" }
          : { kind: "indeterminate", reason: status },
      );
      boundary.dispose();
    },
  );
});
