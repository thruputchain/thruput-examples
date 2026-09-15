import type { Network, Token } from "./network";
import { DEVNET_NETWORK_HASH } from "./network";
import type { SignedApproval } from "./policy";
import type { OutgoingTransfer } from "./lifecycle";
import { ITERATIONS, type Envelope } from "./vault";

export interface Stored {
  // Keep even damaged envelopes intact so creation cannot overwrite a vault.
  envelope?: unknown;
  network: Network;
  pin: string;
  approvals: SignedApproval[];
  tokens: Record<string, Token[]>;
  airdrops: Record<string, string>;
  outgoing: OutgoingTransfer[];
  recoveryBlocked?: boolean;
}
const zero = "0".repeat(64);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);

export function isEnvelope(value: unknown): value is Envelope {
  const e = object(value);
  return (
    e.version === 1 &&
    e.iterations === ITERATIONS &&
    hash(e.salt) &&
    typeof e.iv === "string" &&
    /^[0-9a-f]{24}$/.test(e.iv) &&
    typeof e.ciphertext === "string" &&
    e.ciphertext.length <= 1_000_000 &&
    /^(?:[0-9a-f]{2}){16,}$/.test(e.ciphertext)
  );
}

export function parseStored(value: unknown, extensionOrigin: string): Stored {
  const raw = object(value);
  const fresh = value === undefined;
  const network = fresh || raw.network === "devnet" ? "devnet" : "localnet";
  const validPin =
    (raw.network === "localnet" || raw.network === "devnet") &&
    hash(raw.pin) &&
    (network !== "localnet" || raw.pin === zero);
  const next: Stored = {
    ...(Object.hasOwn(raw, "envelope") ? { envelope: raw.envelope } : {}),
    network,
    // An empty pin requires explicit network selection; never silently repin.
    pin: fresh ? DEVNET_NETWORK_HASH : validPin ? (raw.pin as string) : "",
    approvals: [],
    tokens: {},
    airdrops: {},
    outgoing: [],
  };
  if (raw.recoveryBlocked === true) next.recoveryBlocked = true;
  const outgoing = raw.outgoing === undefined ? [] : raw.outgoing;
  if (!Array.isArray(outgoing)) next.recoveryBlocked = true;
  const recover = (value: unknown, legacy = false) => {
    const r = object(value);
    if (!address(r.hash) || !address(r.account) || !hash(r.networkHash)) {
      next.recoveryBlocked = true;
      return;
    }
    const network = legacy
      ? r.networkHash === zero
        ? "localnet"
        : "devnet"
      : r.network;
    if (
      (network !== "localnet" && network !== "devnet") ||
      (network === "localnet" && r.networkHash !== zero)
    ) {
      next.recoveryBlocked = true;
      return;
    }
    if (
      next.outgoing.some(
        (a) => a.hash === r.hash && a.networkHash === r.networkHash,
      )
    )
      return;
    next.outgoing.push({
      hash: r.hash,
      account: r.account,
      networkHash: r.networkHash,
      network,
      outcome:
        !legacy &&
        (r.outcome === "confirmed" ||
          r.outcome === "failed" ||
          r.outcome === "submitted")
          ? r.outcome
          : "unknown",
      createdAt:
        typeof r.createdAt === "number" &&
        Number.isSafeInteger(r.createdAt) &&
        r.createdAt >= 0
          ? r.createdAt
          : 0,
      ...(typeof r.advisory === "string"
        ? { advisory: r.advisory.slice(0, 1024) }
        : {}),
    });
  };
  if (Array.isArray(outgoing)) outgoing.forEach((r) => recover(r));
  if (Array.isArray(raw.approvals))
    for (const r of raw.approvals)
      if (object(r).origin === extensionOrigin) recover(r, true);
  for (const [pin, values] of Object.entries(object(raw.tokens))) {
    if (!hash(pin) || !Array.isArray(values)) continue;
    const tokens: Token[] = [];
    for (const value of values) {
      const t = object(value);
      if (
        address(t.address) &&
        typeof t.symbol === "string" &&
        t.symbol.length <= 32 &&
        typeof t.decimals === "number" &&
        Number.isInteger(t.decimals) &&
        t.decimals >= 0 &&
        t.decimals <= 38 &&
        !tokens.some((token) => token.address === t.address)
      )
        tokens.push({
          address: t.address,
          symbol: t.symbol,
          decimals: t.decimals,
        });
      if (tokens.length === 64) break;
    }
    next.tokens[pin] = tokens;
  }
  for (const [key, nonce] of Object.entries(object(raw.airdrops)))
    if (
      /^[0-9a-f]{64}:0x[0-9a-f]{64}$/.test(key) &&
      typeof nonce === "string" &&
      /^[0-9a-f]{32}$/.test(nonce)
    )
      next.airdrops[key] = nonce;
  return next;
}
