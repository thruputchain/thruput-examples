import {
  addressFromBase58,
  bytesEqual,
  createThruputClient,
  defineCluster,
  deserializeSignedTransaction,
  fromHex0x,
  hashSignedTransaction,
  hashFromBase58,
  HttpTransport,
  toBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import type { AppConfig } from "../config";
import type { CounterConnection } from "../transactions/engine";

export async function createCounterConnection(
  config: AppConfig,
  rpcUrl: string,
): Promise<CounterConnection> {
  if (!config.signerAddress)
    throw new Error("Development signer is not configured.");
  const controller = new AbortController();
  const expected = networkHash(hashFromBase58(config.networkId));
  const client = await createThruputClient({
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
  const signerAddress = addressFromBase58(config.signerAddress);

  return {
    async read() {
      // One read at a time in the scheduler, so old responses cannot replace new ones.
      const network = await client.getNetworkInfo();
      if (!bytesEqual(network.networkHash, expected))
        throw new Error("Network changed. Check the app configuration.");
      const balance = await client.getBalance({ address: signerAddress });
      return { value: null, signerBalance: balance.rawBalance };
    },
    async prepare(direction) {
      const response = await fetch(new URL("api/prepare", rpcUrl), {
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
        hash: toBase58(hash),
        async submit() {
          const received = await client.sendTransaction({
            signedTransaction: fromHex0x(body.transaction as string),
          });
          if (!bytesEqual(received.transactionHash, hash))
            throw new Error(
              "Submission returned a different transaction hash.",
            );
        },
      };
    },
    async observe(hashText) {
      const hash = hashFromBase58(hashText);
      const receipt = await client.getTransactionReceipt({
        transactionHash: hash,
      });
      if (receipt) {
        if (!bytesEqual(receipt.transactionHash, hash))
          throw new Error("Receipt hash does not match.");
        if (!("result" in receipt.execution))
          throw new Error("Receipt contains an unsupported execution result.");
        return "result" in receipt.execution &&
          receipt.execution.result === "return"
          ? { state: "confirmed", message: null }
          : {
              state: "failed",
              message:
                "Transaction committed without a successful execution result.",
            };
      }
      // Scheduler failures are not proof that the transaction cannot commit later.
      await client.getTransactionStatus({ transactionHash: hash });
      return { state: "pending" };
    },
    dispose() {
      controller.abort();
    },
  };
}
