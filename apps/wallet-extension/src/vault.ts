import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  createPubkeyAccount,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";

export const ITERATIONS = 900_000;
export const DERIVATION = "slip10-ed25519-testnet-v1:m/44'/1'/index':nonce=0";
const aad = new TextEncoder().encode("groundhog-wallet:vault:1");
export interface SecretAccount {
  name: string;
  key: string;
  index?: number;
}
export interface Vault {
  version: 1;
  derivation: typeof DERIVATION;
  mnemonic: string;
  nextIndex: number;
  accounts: SecretAccount[];
}
export interface Envelope {
  version: 1;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function unhex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/.test(value))
    throw new Error("Invalid hexadecimal bytes");
  return Uint8Array.from(value.match(/../g)!, (b) => parseInt(b, 16));
}
async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptVault(
  vault: Vault,
  password: string,
): Promise<Envelope> {
  if (password.length < 12 || password.length > 1024)
    throw new Error("Use a password of 12 to 1024 characters");
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt);
  const clear = new TextEncoder().encode(JSON.stringify(vault));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      clear,
    );
    return {
      version: 1,
      iterations: ITERATIONS,
      salt: hex(salt),
      iv: hex(iv),
      ciphertext: hex(new Uint8Array(ciphertext)),
    };
  } finally {
    clear.fill(0);
  }
}
export async function decryptVault(
  envelope: Envelope,
  password: string,
): Promise<Vault> {
  if (
    envelope.version !== 1 ||
    envelope.iterations !== ITERATIONS ||
    envelope.salt.length !== 64 ||
    envelope.iv.length !== 24 ||
    envelope.ciphertext.length > 1_000_000
  )
    throw new Error("Unsupported vault format");
  let clear: ArrayBuffer;
  try {
    clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(envelope.iv), additionalData: aad },
      await passwordKey(password, unhex(envelope.salt)),
      unhex(envelope.ciphertext),
    );
  } catch {
    throw new Error("Incorrect password or damaged vault");
  }
  try {
    const vault = JSON.parse(new TextDecoder().decode(clear)) as Vault;
    if (
      vault.version !== 1 ||
      vault.derivation !== DERIVATION ||
      !validateMnemonic(vault.mnemonic, wordlist) ||
      !Array.isArray(vault.accounts) ||
      !Number.isSafeInteger(vault.nextIndex)
    )
      throw new Error("Invalid vault contents");
    vault.accounts.forEach((a) => {
      if (!/^[0-9a-f]{64}$/.test(a.key)) throw new Error("Invalid account key");
    });
    return vault;
  } finally {
    new Uint8Array(clear).fill(0);
  }
}
export function deriveKey(mnemonic: string, index: number): string {
  if (
    !validateMnemonic(mnemonic, wordlist) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= 0x80000000
  )
    throw new Error("Invalid mnemonic or account index");
  const seed = mnemonicToSeedSync(mnemonic);
  let node = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  seed.fill(0);
  for (const child of [44, 1, index]) {
    const data = new Uint8Array(37);
    data.set(node.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, child + 0x80000000);
    const next = hmac(sha512, node.subarray(32), data);
    node.fill(0);
    data.fill(0);
    node = next;
  }
  const result = hex(node.subarray(0, 32));
  node.fill(0);
  return result;
}
export function newVault(phrase?: string): Vault {
  const mnemonic =
    phrase === undefined
      ? generateMnemonic(wordlist, 256)
      : phrase.trim().toLowerCase().replace(/\s+/g, " ");
  return {
    version: 1,
    derivation: DERIVATION,
    mnemonic,
    nextIndex: 1,
    accounts: [{ name: "Account 1", index: 0, key: deriveKey(mnemonic, 0) }],
  };
}
export function accountOf(secret: SecretAccount) {
  return createPubkeyAccount({
    signer: new PrivateKeySigner(unhex(secret.key)),
    nonce: 0n,
  });
}
export function publicAccount(secret: SecretAccount) {
  const account = accountOf(secret);
  return {
    address: toHex0x(account.address),
    publicKey: toHex0x(account.authClaim.pubkey_preimage.pubkey.ed25519),
    nonce: "0",
  };
}
