import {
  fromHex0x,
  PrivateKeySigner,
  toHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { AppConfig } from "@/config";
import { parseDevelopmentPersonas } from "@/development-personas";
import { requestStorageKey, transactionScope } from "@/transactions/records";
import { TransactionActivity } from "./transaction-activity";

const config = {
  networkId: "11".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
  transactionProfiles: {
    request: {
      transactionGasLimit: 100_000n,
      targetGasLimit: 100_000n,
      expiryBlocks: 64n,
      observationTimeoutMs: 30_000,
    },
    crank: {
      transactionGasLimit: 10_010_000_000n,
      targetGasLimit: 10_000_000_000n,
      expiryBlocks: 2n,
      observationTimeoutMs: 300_000,
    },
  },
} as Readonly<AppConfig>;

describe("transaction activity", () => {
  test("preserves the read surface and reports malformed durable storage", () => {
    const persona = parseDevelopmentPersonas(JSON.stringify(personas()))![0]!;
    const scope = transactionScope(config, persona.expectedCallerHex);
    localStorage.setItem(requestStorageKey(scope), "malformed");
    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        persona={persona}
        client={{} as GroundhogClient}
        onCrankCommitted={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);
    expect(
      screen.getByRole("button", { name: "Advance 100,000,000 cells" }),
    ).toBeEnabled();
    expect(localStorage.getItem(requestStorageKey(scope))).toBe("malformed");
  });
});

function personas() {
  return (["alice", "bob", "carol"] as const).map((id, index) => {
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
