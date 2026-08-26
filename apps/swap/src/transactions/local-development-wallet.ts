import {
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
import { sha256 } from "@noble/hashes/sha2.js";
import { CxsWriter, serialize } from "@groundhogchain/xdr";

import type { GlobalConfig } from "@/config";
import { createReadClient } from "@/groundhog/client";
import {
  outcomeFromReceipt,
  outcomeFromStatus,
  type TransactionOutcome,
} from "@/transactions/outcome";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

const TRANSACTION_GAS = gasAmount(10_000_000n);
const EXPIRY_BLOCKS = 1_000n;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_POLLS = 40;
const MAX_CONSECUTIVE_POLL_ERRORS = 2;

interface LocalWalletOptions {
  client?: GroundhogClient;
  nonce?: () => bigint;
  delay?: (milliseconds: number) => Promise<void>;
  maxPolls?: number;
}

export interface LocalWalletConfiguration {
  privateKeyHex: string;
  walletEntrypointHex: string;
}

export function createBrowserLocalWriteBoundary(
  config: Pick<GlobalConfig, "rpcUrl" | "networkIdHex" | "accountAddress">,
  privateKeyHex: string | undefined,
): WriteBoundary {
  return createLocalWriteBoundary(
    config,
    {
      privateKeyHex: privateKeyHex ?? "",
      walletEntrypointHex: import.meta.env.VITE_GROUNDHOG_WALLET_ENTRYPOINT,
    },
  );
}

export function createLocalWriteBoundary(
  config: Pick<GlobalConfig, "rpcUrl" | "networkIdHex" | "accountAddress">,
  wallet: LocalWalletConfiguration,
  options: LocalWalletOptions = {},
): WriteBoundary {
  const client = options.client ?? createReadClient(config);
  const delay = options.delay ?? wait;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const observe = async (hash: string): Promise<WriteResult> => {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) {
      return preSubmissionFailure("The stored transaction hash is invalid");
    }
    return pollTransaction(client, hash, maxPolls, delay);
  };

  let signer: PrivateKeySigner;
  let walletEntrypoint: ReturnType<typeof contractEntrypointID>;
  try {
    const privateKey = parseHex(wallet.privateKeyHex, 32, "development private key");
    const entrypoint = parseHex(wallet.walletEntrypointHex, 8, "wallet entrypoint");
    signer = new PrivateKeySigner(privateKey);
    walletEntrypoint = contractEntrypointID(entrypoint);
  } catch (error) {
    return failedBoundary(describeError(error), observe);
  }

  const nonce = options.nonce ?? randomNonce;

  return {
    async execute(target, observer) {
      let signedTransaction: SignedTransaction;
      let hash: string;
      try {
        const tip = await client.getChainTip();
        const transaction = createTransaction({
          invocation: wrapTargetInvocation(
            config.accountAddress,
            walletEntrypoint,
            target,
          ),
          uniquifier: {
            block_expiry_height: blockHeight(tip.height + EXPIRY_BLOCKS),
            nonce: nonce(),
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
        signedTransaction = await signTransaction(
          transaction,
          [{ signer, publicKeyId: 0n }],
          networkHash(sha256Hash(fromHex0x(`0x${config.networkIdHex}`))),
        );
        hash = toHex0x(canonicalTransactionHash(transaction));
        observer?.onSigned(hash);
      } catch (error) {
        return preSubmissionFailure(describeError(error));
      }

      try {
        const rpcHash = toHex0x(await client.sendTransaction(signedTransaction));
        if (rpcHash !== hash) {
          return { kind: "indeterminate", hash, reason: "other" };
        }
      } catch {
        const result = await pollTransaction(client, hash, maxPolls, delay);
        return result.kind === "indeterminate" && result.reason === "timeout"
          ? { kind: "indeterminate", hash, reason: "disconnect" }
          : result;
      }

      return pollTransaction(client, hash, maxPolls, delay);
    },
    observe,
  };
}

export function wrapTargetInvocation(
  walletAddress: ContractAddress,
  walletEntrypoint: ReturnType<typeof contractEntrypointID>,
  target: Invocation,
): Invocation {
  const writer = new CxsWriter();
  writer.writeVarOpaque(serialize(target, codec.Invocation), 0xffff_ffff);
  return {
    invoked_address: walletAddress,
    entrypoint: walletEntrypoint,
    gas_limit: TRANSACTION_GAS,
    calldata: calldata(writer.finish()),
  };
}

export function canonicalTransactionHash(
  transaction: Parameters<typeof serializeTransaction>[0],
): SHA256Hash {
  return sha256Hash(sha256(serializeTransaction(transaction)));
}

async function pollTransaction(
  client: GroundhogClient,
  hashHex: string,
  maxPolls: number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<WriteResult> {
  const hash = sha256Hash(fromHex0x(hashHex));
  let consecutiveErrors = 0;
  let lastIndeterminateReason:
    | Extract<WriteResult, { kind: "indeterminate" }>["reason"]
    | null = null;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      const receipt = await client.getTransactionReceipt(hash);
      if (receipt !== null) {
        if (!bytesEqual(receipt.txHash, hash)) {
          return { kind: "indeterminate", hash: hashHex, reason: "other" };
        }
        return writeResult(hashHex, outcomeFromReceipt(receipt));
      }

      const outcome = outcomeFromStatus(await client.getTransactionStatus(hash));
      consecutiveErrors = 0;
      if (outcome.kind === "invalid") {
        return writeResult(hashHex, outcome);
      }
      if (outcome.kind === "indeterminate") {
        lastIndeterminateReason = outcome.reason;
      }
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        return { kind: "indeterminate", hash: hashHex, reason: "disconnect" };
      }
    }
    await delay(DEFAULT_POLL_INTERVAL_MS);
  }
  return {
    kind: "indeterminate",
    hash: hashHex,
    reason: lastIndeterminateReason ?? "timeout",
  };
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

function failedBoundary(
  message: string,
  observe: NonNullable<WriteBoundary["observe"]>,
): WriteBoundary {
  return { execute: async () => preSubmissionFailure(message), observe };
}

function preSubmissionFailure(message: string): WriteResult {
  return { kind: "preSubmissionFailure", hash: null, message };
}

function parseHex(value: string | undefined, bytes: number, label: string): Uint8Array {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`The generated ${label} must be a ${bytes}-byte 0x-prefixed value`);
  }
  return fromHex0x(value);
}

function randomNonce(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The local development transaction could not be prepared";
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
