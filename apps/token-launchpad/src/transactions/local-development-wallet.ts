import {
  bytesEqual,
  createTransaction,
  fromHex0x,
  PrivateKeySigner,
  serializeTransaction,
  signTransaction,
  toHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import {
  AuthClaimType,
  bitMap,
  blockHeight,
  calldata,
  codec,
  contractEntrypointID,
  gasAmount,
  networkHash,
  sha256Hash,
  weight,
  type ContractAddress,
  type Invocation,
  type SHA256Hash,
  type SignedTransaction,
} from "@groundhogchain/protocol";
import { CxsWriter, serialize } from "@groundhogchain/xdr";
import { sha256 } from "@noble/hashes/sha2.js";

import type { AppConfig } from "@/config";
import { userErrorMessage } from "@/errors";
import { assertExpectedNetwork, createReadClient } from "@/groundhog/client";
import {
  outcomeFromReceipt,
  outcomeFromStatus,
  type TransactionOutcome,
} from "@/transactions/outcome";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

const TRANSACTION_GAS = gasAmount(10_000_000n);
const EXPIRY_BLOCKS = 1_000n;
const POLL_INTERVAL_MS = 500;
const MAX_POLLS = 40;

interface LocalWalletOptions {
  client?: GroundhogClient;
  nonce?: () => bigint;
  delay?: (milliseconds: number) => Promise<void>;
  maxPolls?: number;
}

export function createBrowserWriteBoundary(
  config: AppConfig,
  privateKeyHex: string | undefined,
): WriteBoundary {
  return createLocalWriteBoundary(config, {
    privateKeyHex: privateKeyHex ?? "",
    walletEntrypointHex: import.meta.env.VITE_GROUNDHOG_WALLET_ENTRYPOINT,
  });
}

export function createLocalWriteBoundary(
  config: Pick<
    AppConfig,
    "rpcUrl" | "registryEnabled" | "networkIdHex" | "accountAddress"
  >,
  wallet: { privateKeyHex: string; walletEntrypointHex: string },
  options: LocalWalletOptions = {},
): WriteBoundary {
  const client = options.client ?? createReadClient(config);
  const delay = options.delay ?? wait;
  const maxPolls = options.maxPolls ?? MAX_POLLS;
  const observe = (hash: string) =>
    poll(client, config.networkIdHex, hash, maxPolls, delay);

  let signer: PrivateKeySigner;
  let walletEntrypoint: ReturnType<typeof contractEntrypointID>;
  try {
    signer = new PrivateKeySigner(parseHex(wallet.privateKeyHex, 32));
    walletEntrypoint = contractEntrypointID(
      parseHex(wallet.walletEntrypointHex, 8),
    );
  } catch (error) {
    const message = describe(error);
    return {
      execute: async () => ({
        kind: "preSubmissionFailure",
        hash: null,
        message,
      }),
      observe,
    };
  }

  return {
    async execute(target, observer) {
      let signed: SignedTransaction;
      let hash: string;
      try {
        await assertExpectedNetwork(client, config.networkIdHex);
        const tip = await client.getChainTip();
        const transaction = createTransaction({
          invocation: wrapInvocation(
            config.accountAddress,
            walletEntrypoint,
            target,
          ),
          uniquifier: {
            block_expiry_height: blockHeight(tip.height + EXPIRY_BLOCKS),
            nonce: (options.nonce ?? randomNonce)(),
          },
          contracts_to_deploy: [],
          auth_claim: {
            claim_type: AuthClaimType.kSourceAddressAuthData,
            source_address_claim: {
              allowed_keys: bitMap(1n),
              required_weight: weight(1n),
            },
          },
        });
        signed = await signTransaction(
          transaction,
          [{ signer, publicKeyId: 0n }],
          networkHash(sha256Hash(fromHex0x(`0x${config.networkIdHex}`))),
        );
        hash = toHex0x(canonicalTransactionHash(transaction));
        observer.onSigned(hash);
      } catch (error) {
        return {
          kind: "preSubmissionFailure",
          hash: null,
          message: describe(error),
        };
      }
      try {
        const rpcHash = toHex0x(await client.sendTransaction(signed));
        if (rpcHash !== hash)
          return { kind: "indeterminate", hash, reason: "other" };
      } catch {
        const result = await observe(hash);
        return result.kind === "indeterminate" && result.reason === "timeout"
          ? { kind: "indeterminate", hash, reason: "disconnect" }
          : result;
      }
      return observe(hash);
    },
    observe,
  };
}

export function wrapInvocation(
  wallet: ContractAddress,
  entrypoint: ReturnType<typeof contractEntrypointID>,
  target: Invocation,
): Invocation {
  const writer = new CxsWriter();
  writer.writeVarOpaque(serialize(target, codec.Invocation), 0xffff_ffff);
  return {
    invoked_address: wallet,
    entrypoint,
    gas_limit: TRANSACTION_GAS,
    calldata: calldata(writer.finish()),
  };
}

export function canonicalTransactionHash(
  transaction: Parameters<typeof serializeTransaction>[0],
): SHA256Hash {
  return sha256Hash(sha256(serializeTransaction(transaction)));
}

async function poll(
  client: GroundhogClient,
  expectedNetworkIdHex: string,
  hashHex: string,
  maxPolls: number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<WriteResult> {
  if (!/^0x[0-9a-f]{64}$/.test(hashHex)) {
    return {
      kind: "preSubmissionFailure",
      hash: null,
      message: "The stored transaction hash is invalid",
    };
  }
  const hash = sha256Hash(fromHex0x(hashHex));
  let errors = 0;
  let reason: Extract<WriteResult, { kind: "indeterminate" }>["reason"] =
    "timeout";
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    try {
      await assertExpectedNetwork(client, expectedNetworkIdHex);
      const receipt = await client.getTransactionReceipt(hash);
      if (receipt !== null) {
        if (!bytesEqual(receipt.txHash, hash)) {
          return { kind: "indeterminate", hash: hashHex, reason: "other" };
        }
        return writeResult(hashHex, outcomeFromReceipt(receipt));
      }
      const outcome = outcomeFromStatus(
        await client.getTransactionStatus(hash),
      );
      errors = 0;
      if (outcome.kind === "invalid") return writeResult(hashHex, outcome);
      if (outcome.kind === "indeterminate") reason = outcome.reason;
    } catch {
      errors += 1;
      if (errors >= 2)
        return { kind: "indeterminate", hash: hashHex, reason: "disconnect" };
    }
    await delay(POLL_INTERVAL_MS);
  }
  return { kind: "indeterminate", hash: hashHex, reason };
}

function writeResult(hash: string, outcome: TransactionOutcome): WriteResult {
  switch (outcome.kind) {
    case "invalid":
      return { kind: "invalid", hash, reason: outcome.reason };
    case "committedSuccess":
      return { kind: "committedSuccess", hash, receipt: outcome.receipt };
    case "committedFailure":
      return { kind: "committedFailure", hash, receipt: outcome.receipt };
    case "indeterminate":
      return { kind: "indeterminate", hash, reason: outcome.reason };
    case "pending":
    case "awaitingReceipt":
      return { kind: "indeterminate", hash, reason: "timeout" };
  }
}

function parseHex(value: string, bytes: number): Uint8Array {
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error("The generated development wallet is invalid");
  }
  return fromHex0x(value);
}

function randomNonce(): bigint {
  return crypto.getRandomValues(new BigUint64Array(1))[0]!;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function describe(error: unknown): string {
  return userErrorMessage(
    error,
    "The local development transaction could not be prepared",
  );
}
