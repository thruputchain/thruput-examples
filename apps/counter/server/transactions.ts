import {
  addressFromHex,
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  defaultWalletAdapter,
  defineCluster,
  deserializeSignedTransaction,
  fromHex0x,
  HttpTransport,
  PrivateKeySigner,
  serializeSignedTransaction,
  toHex0x,
} from "@groundhogchain/client";
import {
  blockHeight,
  codec,
  gasAmount,
  networkHash,
  serialize,
  sha256Hash,
} from "@groundhogchain/protocol";
import { Counter } from "../src/contracts/generated/counter";
import type { Direction } from "../src/transactions/engine";
import type { ServerConfig } from "./config";

const GAS = gasAmount(1_000_000n);
const TOPUP_INTERVAL_MS = 10 * 60_000;

export class CounterPolicyError extends Error {}
export class CounterTopupError extends Error {}
export class CounterTopupRateLimitError extends CounterTopupError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      "Signer top-ups are limited to one attempt every 10 minutes. Try again later.",
    );
  }
}

export function parseOperation(body: unknown): Direction {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("direction" in body) ||
    (body.direction !== "increment" && body.direction !== "decrement")
  ) {
    throw new CounterPolicyError(
      "Only an increment or decrement direction is allowed.",
    );
  }
  return body.direction;
}

export function createCounterTransactions(
  config: ServerConfig,
  fetchRpc: typeof fetch = fetch,
) {
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(fromHex0x(config.signingPrivateKey)),
  });
  const expected = networkHash(sha256Hash(fromHex0x(config.app.networkId)));
  const contract = addressFromHex(config.app.counterAddress);
  const invocations = {
    increment: Counter.increment.invocation(contract, GAS, { amount: 1n }),
    decrement: Counter.decrement.invocation(contract, GAS, { amount: 1n }),
  };
  const roots = Object.values(invocations).map((invocation) =>
    serialize(
      defaultWalletAdapter.createRootInvocation(account.address, {
        invocation,
        gasLimit: GAS,
      }),
      codec.Invocation,
    ),
  );
  const authClaim = serialize(account.authClaim, codec.AuthClaim);

  async function connect() {
    const client = await createGroundhogClient({
      cluster: defineCluster({
        name: "counter-signer",
        rpcUrl: config.rpcUrl,
        networkHash: expected,
        capabilities: ["airdrop"] as const,
      }),
      transport: new HttpTransport(config.rpcUrl, {
        timeoutMs: 5_000,
        fetch: (input, init) => fetchRpc(input, { ...init, redirect: "error" }),
      }),
    });
    return createWalletClient({ client, account });
  }
  let walletPromise: ReturnType<typeof connect> | undefined;
  const wallet = () =>
    (walletPromise ??= connect().catch((error: unknown) => {
      walletPromise = undefined;
      throw error;
    }));
  let tipPromise: Promise<bigint> | undefined;
  let tipExpiresAt = 0;
  let preparing = 0;
  let nextTopupAt = 0;

  async function requestTopup() {
    const client = await wallet();
    if (!bytesEqual((await client.getNetworkInfo()).networkHash, expected)) {
      throw new CounterTopupError(
        "Network changed. Check the app configuration.",
      );
    }
    const result = await client.requestAirdrop({
      recipient: account.address,
      timeoutMs: 60_000,
    });
    if (
      result.status.result !== "ok" ||
      !bytesEqual(result.recipient, account.address)
    ) {
      throw new CounterTopupError(
        "The signer airdrop did not execute successfully.",
      );
    }
    return {
      hash: toHex0x(result.txHash),
      rawAmount: result.rawAmount.toString(),
    };
  }

  async function expiryHeight() {
    if (tipPromise && Date.now() < tipExpiresAt) return tipPromise;
    tipExpiresAt = Infinity;
    tipPromise = (async () => {
      const client = await wallet();
      if (!bytesEqual((await client.getNetworkInfo()).networkHash, expected))
        throw new Error("Network changed.");
      return (await client.getChainTip()).height + 1_000n;
    })().finally(() => {
      tipExpiresAt = Date.now() + 500;
    });
    return tipPromise;
  }

  return {
    topup() {
      const now = Date.now();
      const retryAfterSeconds = Math.ceil((nextTopupAt - now) / 1_000);
      if (retryAfterSeconds > 0)
        throw new CounterTopupRateLimitError(retryAfterSeconds);
      // Reserve the window before any asynchronous work, including failed attempts.
      // One timestamp covers every caller; changing IPs cannot bypass it.
      nextTopupAt = now + TOPUP_INTERVAL_MS;
      return requestTopup();
    },
    async prepare(direction: Direction): Promise<{ transaction: string }> {
      if (preparing >= 64) throw new Error("Signing capacity reached.");
      preparing++;
      try {
        const blockExpiryHeight = blockHeight(await expiryHeight());
        const client = await wallet();
        const unsigned = await client.prepareExecution({
          invocation: invocations[direction],
          gasLimit: GAS,
          blockExpiryHeight,
        });
        const signed = await client.signTransaction(unsigned);
        // Preparation never submits. The browser knows the hash before it sends.
        return { transaction: toHex0x(serializeSignedTransaction(signed)) };
      } finally {
        preparing--;
      }
    },
    assertSubmission(params: unknown): void {
      try {
        if (
          !Array.isArray(params) ||
          params.length !== 1 ||
          typeof params[0] !== "string" ||
          params[0].length > 8_192 ||
          !/^0x(?:[0-9a-f]{2})+$/i.test(params[0])
        )
          throw new Error();
        const signed = deserializeSignedTransaction(fromHex0x(params[0]));
        const invocation = serialize(signed.tx.invocation, codec.Invocation);
        if (
          signed.tx.contracts_to_deploy.length !== 0 ||
          !bytesEqual(
            serialize(signed.tx.auth_claim, codec.AuthClaim),
            authClaim,
          ) ||
          !roots.some((root) => bytesEqual(invocation, root))
        )
          throw new Error();
      } catch {
        throw new CounterPolicyError(
          "Only signed +1 or −1 calls to the configured counter are allowed.",
        );
      }
    },
  };
}
