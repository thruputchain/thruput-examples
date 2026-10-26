import {
  addressFromBase58,
  createThruputClient,
  createWalletClient,
  defineCluster,
  hashFromBase58,
  hashSignedTransaction,
  HttpTransport,
  serializeSignedTransaction,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import {
  DefaultWallet,
  ERC20,
  ERC20Metadata,
} from "@thruputchain/client/contracts";
import {
  gasAmount,
  networkHash,
  NATIVE_TOKEN_ADDRESS,
} from "@thruputchain/protocol";
import type { ServerConfig } from "./config";

const CALL_GAS = gasAmount(500_000n);
export const TOKEN_STORAGE_TOPUP = 10_000n;
export interface PreparedClaim {
  hash: string;
  signed: string;
  broadcast(): Promise<void>;
}
export interface ClaimChain {
  check(): Promise<void>;
  inventory(): Promise<{ balances: string[]; packs: number }>;
  prepare(recipient: string): Promise<PreparedClaim>;
  observe(hash: string): Promise<"confirmed" | "failed" | "pending">;
}

export async function createClaimChain(
  config: ServerConfig,
): Promise<ClaimChain> {
  const expected = config.publicConfig;
  const client = await createThruputClient({
    cluster: defineCluster({
      name: "token-faucet",
      rpcUrl: config.rpcUrl,
      networkHash: networkHash(hashFromBase58(expected.networkId)),
      capabilities: [],
    }),
    transport: new HttpTransport(config.rpcUrl, {
      timeoutMs: 10_000,
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
    }),
  });
  const wallet = createWalletClient({ client, account: config.account });
  const tokens = expected.tokens.map((t) => ({
    ...t,
    contract: addressFromBase58(t.address),
  }));
  const chain: ClaimChain = {
    async check() {
      const [info, anchor] = await Promise.all([
        client.getNetworkInfo(),
        client.getBlockByHeight({ blockHeight: BigInt(expected.anchorHeight) }),
      ]);
      if (
        toBase58(info.networkHash) !== expected.networkId ||
        !anchor ||
        toBase58(anchor.blockHash) !== expected.anchorHash
      )
        throw new Error(
          "Network or chain checkpoint changed. Reconfigure the faucet.",
        );
    },
    async inventory() {
      const [native, ...balances] = await Promise.all([
        wallet.getBalance().then((b) => b.rawBalance),
        ...tokens.map((t) =>
          ERC20.v0_1.getBalanceOf
            .view({
              client,
              address: t.contract,
              args: { addr: config.account.address },
            })
            .then((r) => r.value),
        ),
      ]);
      // Keep scheduling capacity and native storage funding available.
      let packs =
        native! > 20_000_000n
          ? (native! - 20_000_000n) /
            (TOKEN_STORAGE_TOPUP * BigInt(tokens.length))
          : 0n;
      for (let i = 0; i < tokens.length; i++)
        packs = min(packs, balances[i]! / BigInt(tokens[i]!.claimAmount));
      return {
        balances: balances.map(String),
        packs: Number(min(packs, 10_000n)),
      };
    },
    async prepare(recipient) {
      await chain.check();
      const receiver = addressFromBase58(recipient);
      // One native wallet batch is atomic: storage reserves and all six transfers
      // commit together, or none of the starter pack is paid.
      const calls = tokens.flatMap((t) => [
        ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, CALL_GAS, {
          receiver: t.contract,
          amount: TOKEN_STORAGE_TOPUP,
        }),
        ERC20.v0_1.transfer.invocation(t.contract, CALL_GAS, {
          receiver,
          amount: BigInt(t.claimAmount),
        }),
      ]);
      const transaction = await wallet.prepareTransaction({
        invocation: DefaultWallet.v0_1.execute.invocation(
          config.account.address,
          gasAmount(10_000_000n),
          {
            calls: calls.map((c) => ({
              target: c.invoked_address,
              entrypoint: c.entrypoint,
              gas_limit: c.gas_limit,
              calldata: c.calldata,
            })),
          },
        ),
        expiryBlocks: 100n,
      });
      const signed = await wallet.signTransaction(transaction);
      const bytes = serializeSignedTransaction(signed);
      const hash = toBase58(hashSignedTransaction(signed));
      return {
        hash,
        signed: toHex0x(bytes),
        async broadcast() {
          const result = await wallet.sendTransaction({
            signedTransaction: bytes,
          });
          if (toBase58(result.transactionHash) !== hash)
            throw new Error("Submission hash mismatch.");
        },
      };
    },
    async observe(hash) {
      await chain.check();
      const receipt = await client.getTransactionReceipt({
        transactionHash: hashFromBase58(hash),
      });
      if (!receipt || !("result" in receipt.execution)) return "pending";
      if (toBase58(receipt.transactionHash) !== hash)
        throw new Error("Receipt hash mismatch.");
      return receipt.execution.result === "return" ? "confirmed" : "failed";
    },
  };
  await chain.check();
  for (const token of tokens) {
    const [symbol, decimals] = await Promise.all([
      ERC20Metadata.v0_1.symbol.view({ client, address: token.contract }),
      ERC20Metadata.v0_1.decimals.view({ client, address: token.contract }),
    ]);
    if (
      symbol.value !== token.symbol ||
      Number(decimals.value) !== token.decimals
    )
      throw new Error("Token metadata does not match configuration.");
  }
  return chain;
}
function min(a: bigint, b: bigint) {
  return a < b ? a : b;
}
