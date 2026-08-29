import {
  addressFromHex,
  fromHex0x,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { gasAmount } from "@groundhogchain/protocol";
import { describe, expect, test } from "vitest";
import { GameOfLife } from "@/contracts/generated/game-of-life";
import { parseDevelopmentPersonas } from "@/development-personas";
import { wrapTargetInvocation } from "./write-boundary";

describe("Life write boundary", () => {
  test("keeps outer and target gas at their measured policy layers", () => {
    const persona = parseDevelopmentPersonas(JSON.stringify(personas()))![0]!;
    const target = GameOfLife.processNextTick.invocation(
      addressFromHex(`0x${"44".repeat(32)}`),
      gasAmount(10_000_000_000n),
    );
    const wrapped = wrapTargetInvocation(persona, target, {
      transactionGasLimit: 10_010_000_000n,
      targetGasLimit: 10_000_000_000n,
      expiryBlocks: 2n,
      observationTimeoutMs: 300_000,
    });
    expect(wrapped.gas_limit).toBe(10_010_000_000n);
    expect(target.gas_limit).toBe(10_000_000_000n);
    expect(wrapped.invoked_address).toEqual(persona.walletRoot);
  });
});

function personas() {
  return ["alice", "bob", "carol"].map((id, index) => {
    const privateKey = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    const signer = new PrivateKeySigner(fromHex0x(privateKey));
    const walletRoot = `0x${(index + 10).toString(16).padStart(64, "0")}`;
    return {
      id,
      label: id,
      privateKey,
      signerPublicKey: toHex0x(signer.publicKey.ed25519),
      walletRoot,
      walletEntrypoint: "0x19846d750fad81d6",
      expectedCaller: walletRoot,
      callerVerified: true,
    };
  });
}
