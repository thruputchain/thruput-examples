import { fromHex0x, PrivateKeySigner, toHex0x } from "@groundhogchain/client";
import { describe, expect, test } from "vitest";
import {
  parseDevelopmentPersonas,
  publicDevelopmentPersona,
} from "./development-personas";

describe("development personas", () => {
  test("validates signer, caller attestation, and fixed persona order", () => {
    const parsed = parseDevelopmentPersonas(JSON.stringify(personas()));
    expect(parsed?.map(({ id }) => id)).toEqual(["alice", "bob", "carol"]);
    expect(publicDevelopmentPersona(parsed![0]!)).not.toHaveProperty(
      "privateKeyHex",
    );
  });

  test("rejects a signer mismatch or unverified caller", () => {
    const invalidSigner = personas();
    invalidSigner[0]!.signerPublicKey = `0x${"ff".repeat(32)}`;
    expect(() =>
      parseDevelopmentPersonas(JSON.stringify(invalidSigner)),
    ).toThrow(/invalid/);
    const invalidCaller = personas();
    invalidCaller[1]!.callerVerified = false;
    expect(() =>
      parseDevelopmentPersonas(JSON.stringify(invalidCaller)),
    ).toThrow(/invalid/);
  });
});

function personas() {
  return (["alice", "bob", "carol"] as const).map((id, index) => {
    const privateKey = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    const signer = new PrivateKeySigner(fromHex0x(privateKey));
    const walletRoot = `0x${(index + 10).toString(16).padStart(64, "0")}`;
    return {
      id,
      label: id[0]!.toUpperCase() + id.slice(1),
      privateKey,
      signerPublicKey: toHex0x(signer.publicKey.ed25519),
      walletRoot,
      walletEntrypoint: "0x19846d750fad81d6",
      expectedCaller: walletRoot,
      callerVerified: true,
    };
  });
}
