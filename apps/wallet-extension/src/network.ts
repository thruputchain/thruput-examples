import {
  createGroundhogClient,
  HttpTransport,
  addressFromHex,
  defaultWalletAdapter,
  prepareTransaction,
  serializeTransaction,
  toHex0x,
} from "@groundhogchain/client";
import { ERC20, ERC20Metadata } from "@groundhogchain/client/contracts";
import { gasAmount } from "@groundhogchain/protocol";
import { accountOf, type SecretAccount } from "./vault";
export const NETWORKS = {
  localnet: "http://127.0.0.1:9545",
  devnet: "https://rpc.thruput.network",
} as const;
export type Network = keyof typeof NETWORKS;
export const DEVNET_NETWORK_HASH =
  "abb9cdbc56285d0e71c9845273ca06211fedf7ee2f58c43cfac6060f9402aa0f";
export const HOG = `0x${"0".repeat(63)}1`;
export interface Token {
  address: string;
  symbol: string;
  decimals: number;
  balance?: string;
  error?: string;
}
export const nativeToken: Token = { address: HOG, symbol: "HOG", decimals: 7 };
export function clientFor(network: Network) {
  return createGroundhogClient({
    transport: new HttpTransport(NETWORKS[network], { timeoutMs: 15000 }),
  });
}
export async function tokenMetadata(
  network: Network,
  address: string,
): Promise<Token> {
  const client = await clientFor(network),
    contract = addressFromHex(address);
  const [symbol, decimals] = await Promise.all([
    ERC20Metadata.v0_1.symbol.view({ client, contract }),
    ERC20Metadata.v0_1.decimals.view({ client, contract }),
  ]);
  if (decimals.value === null || decimals.value < 0n || decimals.value > 38n)
    throw new Error("Token has unsupported decimals");
  return {
    address,
    symbol: (symbol.value || "TOKEN").slice(0, 32),
    decimals: Number(decimals.value),
  };
}
export async function portfolio(
  network: Network,
  owner: string,
  tokens: Token[],
): Promise<Token[]> {
  const client = await clientFor(network);
  return Promise.all(
    tokens.map(async (token) => {
      try {
        const balance =
          token.address === HOG
            ? (await client.getBalance(addressFromHex(owner))).rawBalance
            : (
                await ERC20.v0_1.getBalanceOf.view({
                  client,
                  contract: addressFromHex(token.address),
                  args: { addr: addressFromHex(owner) },
                })
              ).value;
        return { ...token, balance: balance.toString() };
      } catch (error) {
        return {
          ...token,
          error: error instanceof Error ? error.message : "Balance unavailable",
        };
      }
    }),
  );
}
export function parseAmount(value: string, decimals: number): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    throw new Error("Enter a positive decimal amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Use at most ${decimals} decimal places`);
  const amount =
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n || amount >= 2n ** 128n)
    throw new Error("Amount out of range");
  return amount;
}
export async function transferTransaction(
  network: Network,
  secret: SecretAccount,
  token: Token,
  receiver: string,
  amount: string,
) {
  const invocation = defaultWalletAdapter.createRootInvocation(
    accountOf(secret).address,
    {
      gasLimit: gasAmount(1_000_000n),
      invocation: ERC20.v0_1.transfer.invocation(
        addressFromHex(token.address),
        gasAmount(500_000n),
        {
          receiver: addressFromHex(receiver),
          amount: parseAmount(amount, token.decimals),
        },
      ),
    },
  );
  return toHex0x(
    serializeTransaction(
      await prepareTransaction(await clientFor(network), accountOf(secret), {
        invocation,
      }),
    ),
  );
}
export function requireAirdropSuccess(result: { status: { result: string } }) {
  if (result.status.result !== "ok")
    throw new Error(`Airdrop committed but execution ${result.status.result}`);
}
