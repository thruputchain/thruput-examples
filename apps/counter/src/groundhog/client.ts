import {
  addressFromHex,
  bytesEqual,
  createGroundhogClient,
  defineCluster,
  deserializeSignedTransaction,
  fromHex0x,
  hashSignedTransaction,
  hashFromHex,
  HttpTransport,
  toHex0x,
} from "@groundhogchain/client";
import { getContract } from "@groundhogchain/client/contract";
import { ExecResult, networkHash } from "@groundhogchain/protocol";
import type { AppConfig } from "../config";
import { Counter } from "../contracts/generated/counter";
import type { CounterConnection } from "../transactions/engine";

export async function createCounterConnection(
  config: AppConfig,
  rpcUrl: string,
): Promise<CounterConnection> {
  const controller = new AbortController();
  const expected = networkHash(hashFromHex(config.networkId));
  const client = await createGroundhogClient({
    cluster: defineCluster({
      name: "counter",
      rpcUrl,
      networkHash: expected,
      capabilities: [] as const,
    }),
    transport: new HttpTransport(rpcUrl, {
      timeoutMs: 5_000,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        }),
    }),
  });
  const signerAddress = addressFromHex(config.signerAddress);
  const counter = getContract({
    binding: Counter,
    address: addressFromHex(config.counterAddress),
    client,
  });

  return {
    async read() {
      // One read at a time in the scheduler, so old responses cannot replace new ones.
      const network = await client.getNetworkInfo();
      if (!bytesEqual(network.networkHash, expected))
        throw new Error("Network changed. Check the app configuration.");
      const [counterView, balance] = await Promise.all([
        counter.get.view({ caller: signerAddress }),
        client.getBalance(signerAddress),
      ]);
      return { value: counterView.value, signerBalance: balance.rawBalance };
    },
    async prepare(direction) {
      const response = await fetch(new URL("/api/prepare", rpcUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(5_000),
        ]),
      });
      if (!response.ok)
        throw new Error("Counter signing is unavailable. Try again shortly.");
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("transaction" in body) ||
        typeof body.transaction !== "string" ||
        body.transaction.length > 8_192
      ) {
        throw new Error("The server returned an invalid counter transaction.");
      }
      const signed = deserializeSignedTransaction(fromHex0x(body.transaction));
      const hash = hashSignedTransaction(signed);
      return {
        hash: toHex0x(hash),
        async submit() {
          const received = await client.sendTransaction(signed);
          if (!bytesEqual(received, hash))
            throw new Error(
              "Submission returned a different transaction hash.",
            );
        },
      };
    },
    async observe(hashHex) {
      const hash = hashFromHex(hashHex);
      const receipt = await client.getTransactionReceipt(hash);
      if (receipt) {
        if (!bytesEqual(receipt.txHash, hash))
          throw new Error("Receipt hash does not match.");
        return receipt.execResult === ExecResult.ExecResultOK
          ? { state: "confirmed", message: null }
          : {
              state: "failed",
              message: `Transaction failed: ${ExecResult[receipt.execResult]}.`,
            };
      }
      const status = await client.getTransactionStatus(hash);
      return status.status === "invalid"
        ? { state: "failed", message: status.reason }
        : { state: "pending" };
    },
    dispose() {
      controller.abort();
    },
  };
}
