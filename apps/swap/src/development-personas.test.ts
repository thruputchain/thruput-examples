import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import {
  DevelopmentPersonaError,
  parseDevelopmentPersonas,
  personaPreferenceKey,
  selectedDevelopmentPersona,
} from "@/development-personas";

const address = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

describe("development personas", () => {
  it("parses and orders the three known local wallets", () => {
    const parsed = parseDevelopmentPersonas(JSON.stringify([
      persona("carol", 3),
      persona("alice", 1),
      persona("bob", 2),
    ]));

    expect(parsed?.map(({ id }) => id)).toEqual(["alice", "bob", "carol"]);
    expect(parsed?.[1]).toMatchObject({
      label: "Bob",
      accountAddressHex: address(2),
      privateKeyHex: address(12),
    });
  });

  it("rejects duplicate addresses, keys, and missing personas", () => {
    const duplicate = [
      persona("alice", 1),
      persona("bob", 1),
      persona("carol", 3),
    ];
    expect(() => parseDevelopmentPersonas(JSON.stringify(duplicate)))
      .toThrow(DevelopmentPersonaError);
    expect(() => parseDevelopmentPersonas(JSON.stringify(duplicate.slice(0, 2))))
      .toThrow(DevelopmentPersonaError);
  });

  it("defaults stale selection to Alice and scopes the tab preference", () => {
    const parsed = parseDevelopmentPersonas(JSON.stringify([
      persona("alice", 1),
      persona("bob", 2),
      persona("carol", 3),
    ]))!;
    expect(selectedDevelopmentPersona(parsed, "missing").id).toBe("alice");
    expect(personaPreferenceKey("00".repeat(32), contractAddress(new Uint8Array(32).fill(9))))
      .toContain(`${"00".repeat(32)}:0x${"09".repeat(32)}`);
  });
});

function persona(id: "alice" | "bob" | "carol", byte: number) {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    description: `${id} role`,
    accountAddress: address(byte),
    privateKey: address(byte + 10),
  };
}
