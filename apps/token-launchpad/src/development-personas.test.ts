import { describe, expect, it } from "vitest";

import {
  parseDevelopmentPersonas,
  preferenceKey,
  publicPersona,
} from "@/development-personas";
import { contractAddress } from "@groundhogchain/protocol";

function serialized() {
  return JSON.stringify(
    ["alice", "bob", "carol"].map((id, index) => ({
      id,
      label: id[0]!.toUpperCase() + id.slice(1),
      accountAddress: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      privateKey: `0x${(index + 4).toString(16).padStart(64, "0")}`,
    })),
  );
}

describe("development personas", () => {
  it("parses all personas and omits private keys from public values", () => {
    const personas = parseDevelopmentPersonas(serialized())!;
    expect(personas.map(({ id }) => id)).toEqual(["alice", "bob", "carol"]);
    expect(publicPersona(personas[0]!)).not.toHaveProperty("privateKeyHex");
  });

  it("rejects duplicates and malformed key material", () => {
    const duplicate = JSON.parse(serialized());
    duplicate[1].id = "alice";
    expect(() => parseDevelopmentPersonas(JSON.stringify(duplicate))).toThrow();
    const malformed = JSON.parse(serialized());
    malformed[0].privateKey = "secret";
    expect(() => parseDevelopmentPersonas(JSON.stringify(malformed))).toThrow();
  });

  it("scopes the preference to the launchpad network and factory", () => {
    expect(
      preferenceKey(
        "01".repeat(32),
        contractAddress(new Uint8Array(32).fill(2)),
      ),
    ).toContain("groundhog-token-launchpad:active-persona:v1");
  });
});
