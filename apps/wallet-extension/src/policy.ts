import type { ProviderRequest } from "@groundhogchain/client/provider";
export const MAX_SIGNED_BYTES = 1_048_576;
// One Ed25519 DecoratedSignature plus the signature vector length.
export const MAX_UNSIGNED_BYTES = MAX_SIGNED_BYTES - 76;
export const MAX_UNSIGNED_HEX = 2 + MAX_UNSIGNED_BYTES * 2;
export const MAX_SIGNED_HEX = 2 + MAX_SIGNED_BYTES * 2;
export class WalletError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(code: number, message: string): never {
  throw new WalletError(code, message);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(-32602, "Expected an object");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    fail(-32602, "Unexpected field");
}
export function text(value: unknown, max = 1024): string {
  if (typeof value !== "string" || value.length > max)
    fail(-32602, "Invalid string");
  return value;
}
export function address(value: unknown): string {
  const result = text(value, 66);
  if (!/^0x[0-9a-f]{64}$/.test(result))
    fail(-32602, "Expected a canonical 32-byte address");
  return result;
}
export function requestSchema(value: unknown): ProviderRequest {
  const r = record(value);
  exact(r, ["method", "params"]);
  if (["connect", "getSession", "disconnect"].includes(String(r.method))) {
    if (r.params !== undefined) fail(-32602, "This method takes no parameters");
  } else if (r.method === "getCapabilities") {
    const p = record(r.params);
    exact(p, ["account", "networkHash"]);
    address(p.account);
    if (!/^[0-9a-f]{64}$/.test(text(p.networkHash, 64)))
      fail(-32602, "Invalid network hash");
  } else if (
    r.method === "signTransaction" ||
    r.method === "submitTransaction"
  ) {
    const p = record(r.params);
    const field =
      r.method === "signTransaction" ? "transaction" : "signedTransaction";
    exact(p, ["account", "networkHash", field]);
    address(p.account);
    if (!/^[0-9a-f]{64}$/.test(text(p.networkHash, 64)))
      fail(-32602, "Invalid network hash");
    if (
      !/^0x(?:[0-9a-f]{2})+$/.test(
        text(
          p[field],
          r.method === "signTransaction" ? MAX_UNSIGNED_HEX : MAX_SIGNED_HEX,
        ),
      )
    )
      fail(-32602, "Expected canonical XDR hex");
  } else fail(4200, "Unsupported wallet method");
  return r as unknown as ProviderRequest;
}
export function pageOrigin(sender: chrome.runtime.MessageSender): string {
  if (
    sender.frameId !== 0 ||
    !sender.tab?.id ||
    !sender.documentId ||
    !sender.url ||
    !sender.origin ||
    sender.origin === "null"
  )
    fail(4100, "Only top-level HTTP(S) documents may connect");
  const url = new URL(sender.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== sender.origin
  )
    fail(4100, "Untrusted document origin");
  return url.origin;
}
export interface SignedApproval {
  origin: string;
  account: string;
  networkHash: string;
  signedTransaction: string;
  hash: string;
}
export function canSubmit(
  approval: SignedApproval | undefined,
  candidate: Omit<SignedApproval, "hash">,
  unlocked: boolean,
  granted: boolean,
) {
  return Boolean(
    unlocked &&
    granted &&
    approval &&
    approval.origin === candidate.origin &&
    approval.account === candidate.account &&
    approval.networkHash === candidate.networkHash &&
    approval.signedTransaction === candidate.signedTransaction,
  );
}
