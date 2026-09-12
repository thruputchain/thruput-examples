import {
  addressFromHex,
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  defineCluster,
  fromHex0x,
  hashSignedTransaction,
  HttpTransport,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import {
  blockHeight,
  ExecResult,
  gasAmount,
  networkHash,
  sha256Hash,
} from "@groundhogchain/protocol";
import type { AppConfig } from "../config";
import { Counter } from "../contracts/generated/counter";
import type { CounterConnection } from "../transactions/engine";

const TRANSACTION_GAS = gasAmount(1_000_000n);
const EXPIRY_BLOCKS = 1_000n;

export async function createCounterConnection(
  config: AppConfig,
  rpcUrl: string,
): Promise<CounterConnection> {
  const controller = new AbortController();
  const expected = networkHash(sha256Hash(fromHex0x(config.networkId)));
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
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(fromHex0x(config.developmentPrivateKey)),
  });
  const wallet = createWalletClient({ client, account });
  const contract = addressFromHex(config.counterAddress);
  let tip: { height: bigint; readAt: number } | null = null;
  let balanceCheckedAt = 0;

  return {
    async read() {
      // One read at a time in the scheduler, so old responses cannot replace new ones.
      const network = await client.getNetworkInfo();
      if (!bytesEqual(network.networkHash, expected))
        throw new Error("Network changed. Check the app configuration.");
      const [chainTip, counter] = await Promise.all([
        client.getChainTip(),
        Counter.get.view({ client, contract, caller: account.address }),
      ]);
      if (Date.now() - balanceCheckedAt >= 10_000) {
        if ((await wallet.getBalance()).rawBalance <= 0n)
          throw new Error(
            "The development account needs test HOG. Fund it before continuing.",
          );
        balanceCheckedAt = Date.now();
      }
      tip = { height: chainTip.height, readAt: Date.now() };
      return counter.value;
    },
    async prepare(direction) {
      if (tip === null || Date.now() - tip.readAt > 5_000)
        throw new Error(
          "Chain tip is stale. Wait for the connection to recover.",
        );
      const transaction = await wallet.prepareExecution({
        invocation: Counter[direction].invocation(contract, TRANSACTION_GAS, {
          amount: 1n,
        }),
        gasLimit: TRANSACTION_GAS,
        blockExpiryHeight: blockHeight(tip.height + EXPIRY_BLOCKS),
      });
      const signed = await wallet.signTransaction(transaction);
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
      const hash = sha256Hash(fromHex0x(hashHex));
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
