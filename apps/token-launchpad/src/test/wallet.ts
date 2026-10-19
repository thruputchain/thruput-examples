import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
  MockTransport,
  PrivateKeySigner,
  toBase58,
} from "@thruputchain/client";
import { createPubkeyAccount } from "@thruputchain/client/wallet";
import {
  registerWalletProvider,
  type WalletProvider,
  type WalletSession,
} from "@thruputchain/client/provider";
import { networkHash } from "@thruputchain/protocol";
import { vi } from "vitest";

export function testClient(networkId: string) {
  const transport = new MockTransport();
  return createThruputClient({
    cluster: defineCluster({
      networkHash: networkHash(hashFromBase58(networkId)),
      capabilities: [] as const,
    }),
    transport: {
      request: (method, params) =>
        method === "groundhog_networkInfo"
          ? Promise.resolve({ networkHash: networkId } as never)
          : transport.request(method, params),
    },
  });
}

export function testAccount(nonce = 1n) {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer, nonce });
  return {
    address: toBase58(account.address),
    publicKey: toBase58(signer.publicKey.ed25519),
    nonce: nonce.toString(),
  };
}

export function testWallet(networkHash: string) {
  let session: WalletSession = { networkHash, accounts: [testAccount()] };
  const listeners = new Set<(value: WalletSession) => void>();
  const request = vi.fn<WalletProvider["request"]>(async () => session);
  const unregister = registerWalletProvider({
    info: { id: "test", name: "Test Wallet", version: "2.0.0" },
    request,
    on(_event, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    request,
    unregister,
    change(next: WalletSession) {
      session = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}
