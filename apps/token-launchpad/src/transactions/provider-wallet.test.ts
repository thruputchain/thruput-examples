import {
  fromHex0x,
  hashSignedTransaction,
  PrivateKeySigner,
  signTransaction,
  toHex0x,
  type GroundhogClient,
  type TransactionReceipt,
} from "@groundhogchain/client";
import { DefaultWallet } from "@groundhogchain/client/contracts";
import {
  parseTransactionHex,
  type ProviderRequest,
  type WalletProvider,
  type WalletSession,
} from "@groundhogchain/client/provider";
import { createPubkeyAccount } from "@groundhogchain/client/wallet";
import {
  blockHeight,
  calldata,
  codec,
  contractAddress,
  contractEntrypointID,
  ContractType,
  ExecResult,
  gasAmount,
  networkHash,
  serialize,
  sha256Hash,
} from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/config";
import { StandardTokenFactory } from "@/contracts/generated/standard-token-factory";
import {
  createProviderWriteBoundary,
  createTransactionObserver,
} from "./provider-wallet";
import { hashContract } from "@groundhogchain/client";

const config = loadConfig({
  VITE_GROUNDHOG_RPC_URL: "http://localhost:9545",
  VITE_GROUNDHOG_NETWORK_ID: "ab".repeat(32),
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"04".repeat(32)}`,
  VITE_NATIVE_HOG_ADDRESS: `0x${"05".repeat(32)}`,
  VITE_STANDARD_TOKEN_HASH: `0x${"06".repeat(32)}`,
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
});
const target = {
  invoked_address: contractAddress(new Uint8Array(32).fill(9)),
  entrypoint: contractEntrypointID(new Uint8Array(8)),
  gas_limit: gasAmount(1000n),
  calldata: calldata(new Uint8Array()),
};
const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
const localAccount = createPubkeyAccount({ signer, nonce: 7n });
const account = {
  address: toHex0x(localAccount.address),
  publicKey: toHex0x(signer.publicKey.ed25519),
  nonce: "7",
};
const signingNetwork = networkHash(
  sha256Hash(fromHex0x(`0x${config.networkIdHex}`)),
);
const childReturn = new Uint8Array(32).fill(8);
const returnWriter = new CxsWriter();
returnWriter.writeUint32(1n);
returnWriter.writeVarOpaque(childReturn, 0xffff_ffff);
const wrappedReturn = returnWriter.finish();

function setup() {
  let session: WalletSession = {
    networkHash: config.networkIdHex,
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
        DefaultWallet.execute.entrypoint,
      );
      expect(tx.auth_claim).toEqual(localAccount.authClaim);
      expect(tx.uniquifier.block_expiry_height).toBe(1_010n);
      const signed = await signTransaction(
        tx,
        localAccount.signers,
        signingNetwork,
      );
      canonicalHash = toHex0x(hashSignedTransaction(signed));
      return {
        signedTransaction: toHex0x(serialize(signed, codec.SignedTransaction)),
        hash: canonicalHash,
      };
    }
    if (input.method === "submitTransaction") return { hash: canonicalHash };
    return null;
  });
  const provider: WalletProvider = {
    info: { id: "test", name: "Test Wallet", version: "1.0.0" },
    request,
    on(_event, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const receipt = (hash: Uint8Array): TransactionReceipt => ({
    txHash: sha256Hash(hash),
    height: blockHeight(11n),
    execResult: ExecResult.ExecResultOK,
    events: [],
    returnData: wrappedReturn,
    abortData: null,
  });
  const client = {
    getNetworkInfo: vi.fn().mockResolvedValue({ networkHash: signingNetwork }),
    getChainTip: vi.fn().mockResolvedValue({ height: 10n }),
    getTransactionReceipt: vi.fn(async (hash: Uint8Array) => receipt(hash)),
    getTransactionStatus: vi.fn().mockResolvedValue({ status: "unknown" }),
    sendTransaction: vi.fn(),
  };
  const boundary = createProviderWriteBoundary(
    config,
    client as unknown as GroundhogClient,
    provider,
    account,
  );
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
  it("awaits persistence, submits only through the provider, and unwraps child returns without changing evidence", async () => {
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
    expect(result.receipt.returnData).toEqual(childReturn);
    expect(toHex0x(result.receipt.txHash)).toBe(result.hash);
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
      expect(result.kind).toBe("preSubmissionFailure");
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
        ? { hash: `0x${"ff".repeat(32)}` }
        : original(input),
    );
    const onSigned = vi.fn();
    try {
      const result = await boundary.execute(target, { onSigned });
      expect(result).toMatchObject({
        kind: "committedSuccess",
        hash: onSigned.mock.calls[0]![0],
      });
      expect(client.getTransactionReceipt).toHaveBeenCalledWith(
        fromHex0x(onSigned.mock.calls[0]![0]),
      );
    } finally {
      boundary.dispose();
    }
  });

  it("invalidates a pending old adapter on account change but keeps polling independent", async () => {
    const { boundary, change, request } = setup();
    const result = await boundary.execute(target, {
      onSigned() {
        change({ networkHash: config.networkIdHex, accounts: [] });
      },
    });
    expect(result.kind).toBe("committedSuccess");
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
            hash: toHex0x(hash),
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const writer = createProviderWriteBoundary(
      { ...config, expectedTokenHash: hash },
      client as unknown as GroundhogClient,
      provider,
      account,
    );
    await writer.execute(target, { onSigned() {} });
    expect(fetch).not.toHaveBeenCalled();
    const creation = {
      ...target,
      invoked_address: config.factoryAddress,
      entrypoint: StandardTokenFactory.createToken.entrypoint,
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
    writer.dispose();
    boundary.dispose();
  });

  it.each(["invalid", "unknown", "recentFailure"])(
    "preserves %s status semantics",
    async (status) => {
      const { client, boundary } = setup();
      client.getTransactionReceipt.mockResolvedValue(null as never);
      client.getTransactionStatus.mockResolvedValue({
        status,
        reason: "Rejected",
      });
      const observe = createTransactionObserver(
        config,
        client as unknown as GroundhogClient,
        { maxPolls: 1, delay: async () => {} },
      );
      expect(await observe(`0x${"01".repeat(32)}`)).toMatchObject(
        status === "invalid"
          ? { kind: "invalid", reason: "Rejected" }
          : { kind: "indeterminate", reason: status },
      );
      boundary.dispose();
    },
  );
});
