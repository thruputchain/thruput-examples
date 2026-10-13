import {
  createThruputClient,
  defineCluster,
  hashFromHex,
  MockTransport,
  PrivateKeySigner,
  toHex0x,
} from "@thruputchain/client";
import { createPubkeyAccount } from "@thruputchain/client/wallet";
import {
  registerWalletProvider,
  type WalletProvider,
  type WalletSession,
} from "@thruputchain/client/provider";
import { networkHash } from "@thruputchain/protocol";
import { vi } from "vitest";

export function testClient(networkIdHex: string) {
  const transport = new MockTransport();
  return createThruputClient({
    cluster: defineCluster({
      networkHash: networkHash(hashFromHex(`0x${networkIdHex}`)),
      capabilities: [] as const,
    }),
    transport: {
      request: (method, params) =>
        method === "groundhog_networkInfo"
          ? Promise.resolve({ networkHash: `0x${networkIdHex}` } as never)
          : transport.request(method, params),
    },
  });
}

export function testAccount(nonce = 1n) {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer, nonce });
  return {
    address: toHex0x(account.address),
    publicKey: toHex0x(signer.publicKey.ed25519),
    nonce: nonce.toString(),
  };
}

export function testWallet(networkHash: string) {
  let session: WalletSession = { networkHash, accounts: [testAccount()] };
  const listeners = new Set<(value: WalletSession) => void>();
  const request = vi.fn<WalletProvider["request"]>(async () => session);
  const unregister = registerWalletProvider({
    info: { id: "test", name: "Test Wallet", version: "1.0.0" },
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
