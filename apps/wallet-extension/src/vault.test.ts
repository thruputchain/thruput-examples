import { describe, expect, it } from "vitest";
import {
  decryptVault,
  deriveKey,
  encryptVault,
  newVault,
  publicAccount,
  DERIVATION,
} from "./vault";
const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
describe("encrypted vault", () => {
  it("roundtrips, uses fresh salt and IV, and never persists plaintext", async () => {
    const vault = newVault(phrase),
      password = "a strong test password";
    const a = await encryptVault(vault, password),
      b = await encryptVault(vault, password);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain(phrase);
    expect(JSON.stringify(a)).not.toContain(vault.accounts[0]!.key);
    expect(await decryptVault(a, password)).toEqual(vault);
    await expect(decryptVault(a, "wrong password")).rejects.toThrow(
      "Incorrect password",
    );
    await expect(
      decryptVault(
        {
          ...a,
          ciphertext:
            (a.ciphertext.startsWith("ff") ? "00" : "ff") +
            a.ciphertext.slice(2),
        },
        password,
      ),
    ).rejects.toThrow();
    await expect(
      decryptVault({ ...a, version: 2 } as never, password),
    ).rejects.toThrow("Unsupported");
  });
  it("versions hardened testnet derivation with explicit address nonce zero", () => {
    const vault = newVault(phrase);
    expect(vault.derivation).toBe(DERIVATION);
    expect(deriveKey(phrase, 0)).toBe(vault.accounts[0]!.key);
    expect(deriveKey(phrase, 1)).not.toBe(deriveKey(phrase, 0));
    expect(publicAccount(vault.accounts[0]!)).toMatchObject({ nonce: "0" });
    expect(publicAccount(vault.accounts[0]!).address).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(() => deriveKey(phrase, -1)).toThrow();
    expect(() => newVault("invalid phrase")).toThrow();
    expect(() => newVault("   ")).toThrow();
  });
});
