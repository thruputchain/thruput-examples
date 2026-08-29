import {
  createTransaction,
  fromHex0x,
  PrivateKeySigner,
  serializeTransaction,
  signTransaction,
  toHex0x,
  type GroundhogClient,
  type TransactionReceipt,
  type TransactionStatus,
} from "@groundhogchain/client";
import {
  AuthClaimType,
  bitMap,
  blockHeight,
  calldata,
  codec,
  gasAmount,
  networkHash,
  sha256Hash,
  weight,
  ExecResult,
  type Invocation,
  type SHA256Hash,
  type SignedTransaction,
} from "@groundhogchain/protocol";
import { CxsWriter, serialize } from "@groundhogchain/xdr";
import { sha256 } from "@noble/hashes/sha2.js";
import type { AppConfig, TransactionPolicy } from "@/config";
import type { DevelopmentPersona } from "@/development-personas";

export type WriteResult =
  | {
      readonly kind: "preSubmissionFailure";
      readonly hash: null;
      readonly message: string;
    }
  | { readonly kind: "invalid"; readonly hash: string; readonly reason: string }
  | {
      readonly kind: "committedSuccess";
      readonly hash: string;
      readonly receipt: TransactionReceipt;
    }
  | {
      readonly kind: "committedFailure";
      readonly hash: string;
      readonly receipt: TransactionReceipt;
    }
  | {
      readonly kind: "indeterminate";
      readonly hash: string | null;
      readonly reason:
        "recentFailure" | "unknown" | "other" | "timeout" | "disconnect";
    };

export interface WriteBoundary {
  execute(
    target: Invocation,
    policy: TransactionPolicy,
    observer: { readonly onSigned: (hash: string) => void },
  ): Promise<WriteResult>;
  observe(hash: string, timeoutMs?: number): Promise<WriteResult>;
}

interface BoundaryOptions {
  readonly client?: GroundhogClient;
  readonly nonce?: () => bigint;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export function createLocalWriteBoundary(
  config: Pick<AppConfig, "networkId">,
  persona: DevelopmentPersona,
  client: GroundhogClient,
  options: BoundaryOptions = {},
): WriteBoundary {
  const signer = new PrivateKeySigner(fromHex0x(persona.privateKeyHex));
  const delay = options.delay ?? wait;
  const nonce = options.nonce ?? randomNonce;
  const observe = (hash: string, timeoutMs = 30_000) =>
    pollTransaction(options.client ?? client, hash, timeoutMs, delay);
  return {
    async execute(target, policy, observer) {
      let signed: SignedTransaction;
      let hash: string;
      try {
        const tip = await client.getChainTip();
        const transaction = createTransaction({
          invocation: wrapTargetInvocation(persona, target, policy),
          uniquifier: {
            block_expiry_height: blockHeight(tip.height + policy.expiryBlocks),
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
        signed = await signTransaction(
          transaction,
          [{ signer, publicKeyId: 0n }],
          networkHash(sha256Hash(fromHex0x(`0x${config.networkId}`))),
        );
        hash = toHex0x(canonicalTransactionHash(transaction));
        observer.onSigned(hash);
      } catch (cause) {
        return {
          kind: "preSubmissionFailure",
          hash: null,
          message: describe(cause),
        };
      }
      try {
        const rpcHash = toHex0x(await client.sendTransaction(signed));
        if (rpcHash !== hash)
          return { kind: "indeterminate", hash, reason: "other" };
      } catch {
        const recovered = await observe(hash, policy.observationTimeoutMs);
        return recovered.kind === "indeterminate" &&
          recovered.reason === "timeout"
          ? { kind: "indeterminate", hash, reason: "disconnect" }
          : recovered;
      }
      return observe(hash, policy.observationTimeoutMs);
    },
    observe,
  };
}

export function wrapTargetInvocation(
  persona: Pick<DevelopmentPersona, "walletRoot" | "walletEntrypoint">,
  target: Invocation,
  policy: TransactionPolicy,
): Invocation {
  const writer = new CxsWriter();
  writer.writeVarOpaque(serialize(target, codec.Invocation), 0xffff_ffff);
  return {
    invoked_address: persona.walletRoot,
    entrypoint: persona.walletEntrypoint,
    gas_limit: gasAmount(policy.transactionGasLimit),
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
  timeoutMs: number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<WriteResult> {
  if (!/^0x[0-9a-f]{64}$/.test(hashHex))
    return {
      kind: "preSubmissionFailure",
      hash: null,
      message: "Stored transaction hash is invalid",
    };
  const hash = sha256Hash(fromHex0x(hashHex));
  const deadline = Date.now() + timeoutMs;
  let errors = 0;
  let reason: Extract<WriteResult, { kind: "indeterminate" }>["reason"] =
    "timeout";
  while (Date.now() < deadline) {
    try {
      const receipt = await client.getTransactionReceipt(hash);
      if (receipt) {
        if (toHex0x(receipt.txHash) !== hashHex)
          return { kind: "indeterminate", hash: hashHex, reason: "other" };
        return receipt.execResult === ExecResult.ExecResultOK
          ? { kind: "committedSuccess", hash: hashHex, receipt }
          : { kind: "committedFailure", hash: hashHex, receipt };
      }
      const status = await client.getTransactionStatus(hash);
      const result = statusResult(hashHex, status);
      if (result) return result;
      reason =
        status.status === "recentFailure"
          ? "recentFailure"
          : status.status === "unknown"
            ? "unknown"
            : reason;
      errors = 0;
    } catch {
      errors += 1;
      if (errors >= 2)
        return { kind: "indeterminate", hash: hashHex, reason: "disconnect" };
    }
    await delay(500);
  }
  return { kind: "indeterminate", hash: hashHex, reason };
}

function statusResult(
  hash: string,
  status: TransactionStatus,
): WriteResult | null {
  if (status.status === "invalid")
    return { kind: "invalid", hash, reason: status.reason };
  if (status.status === "other")
    return { kind: "indeterminate", hash, reason: "other" };
  return null;
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describe(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "The local development transaction could not be prepared";
}
