import { describe, expect, it } from "vitest";
import { parseStored } from "./storage";
import { MAX_OUTGOING } from "./lifecycle";
import { DEVNET_NETWORK_HASH } from "./network";

const pin = "00".repeat(32);
const account = `0x${"11".repeat(32)}`;
const origin = "chrome-extension://extension/";
const record = {
  hash: account,
  account,
  network: "localnet",
  networkHash: pin,
  outcome: "unknown",
  createdAt: 123,
};

describe("persisted wallet normalization", () => {
  it("defaults fresh wallets to Devnet and preserves a saved Localnet selection", () => {
    expect(parseStored(undefined, origin)).toMatchObject({
      network: "devnet",
      pin: DEVNET_NETWORK_HASH,
    });
    expect(parseStored({ network: "localnet", pin }, origin)).toMatchObject({
      network: "localnet",
      pin,
    });
  });
  it.each([undefined, null, [], 42, "invalid"])(
    "handles arbitrary roots (%j)",
    (value) => {
      expect(parseStored(value, origin)).toMatchObject({
        approvals: [],
        tokens: {},
        airdrops: {},
        outgoing: [],
      });
    },
  );
  it("defaults missing collections and discards persisted permissions", () => {
    expect(
      parseStored({ network: "localnet", pin, grants: { evil: {} } }, origin),
    ).toEqual({
      network: "localnet",
      pin,
      approvals: [],
      tokens: {},
      airdrops: {},
      outgoing: [],
    });
  });
  it.each([null, {}, "invalid"])(
    "blocks retries when the recovery collection is damaged (%j)",
    (outgoing) => {
      const parsed = parseStored({ outgoing }, origin);
      expect(parsed.recoveryBlocked).toBe(true);
      expect(parseStored(parsed, origin).recoveryBlocked).toBe(true);
    },
  );
  it("validates token metadata and retains valid retry nonces", () => {
    const token = { address: account, symbol: "TEST", decimals: 7 };
    const key = `${pin}:${account}`;
    const parsed = parseStored(
      {
        tokens: {
          [pin]: [null, {}, token, token, { ...token, decimals: 100 }],
          invalid: [token],
        },
        airdrops: { [key]: "12".repeat(16), invalid: "12".repeat(16) },
      },
      origin,
    );
    expect(parsed.tokens).toEqual({ [pin]: [token] });
    expect(parsed.airdrops).toEqual({ [key]: "12".repeat(16) });
  });
  it("keeps network identities and refuses inconsistent recovery endpoints", () => {
    const devnet = "ab".repeat(32);
    const parsed = parseStored(
      {
        network: "devnet",
        pin: devnet,
        outgoing: [
          { ...record, network: "devnet", networkHash: devnet },
          { ...record, networkHash: devnet },
        ],
      },
      origin,
    );
    expect(parsed.pin).toBe(devnet);
    expect(parsed.outgoing).toEqual([
      { ...record, network: "devnet", networkHash: devnet },
    ]);
    expect(parsed.recoveryBlocked).toBe(true);
  });
  it("preserves every valid recovery hash beyond the creation limit", () => {
    const outgoing = Array.from({ length: MAX_OUTGOING + 1 }, (_, i) => ({
      ...record,
      hash: `0x${i.toString(16).padStart(64, "0")}`,
    }));
    const parsed = parseStored({ outgoing }, origin);
    expect(parsed.outgoing).toEqual(outgoing);
    expect(parsed.recoveryBlocked).toBeUndefined();
  });
});
