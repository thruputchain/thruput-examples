import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import {
  renderEnvironment,
  validateLocalRpcUrl,
  validateRuntimeManifest,
  validateWireFormat,
  type RuntimeManifest,
} from "@/setup/local-environment";

function manifest(): RuntimeManifest {
  return {
    schemaVersion: 2,
    kind: "hogd-dev-runtime",
    chainState: "fresh",
    networkHash: `0x${"11".repeat(32)}`,
    producer: {
      binary: "hog-devnode",
      version: "0.1.25-rc.1",
      commitHash: "abc",
    },
    bootstrapAccountDerivation: {
      scheme: "groundhog-bootstrap-account-v1",
      seed: "test",
    },
    bootstrapAccounts: [
      {
        index: 10,
        role: "faucet",
        publicKey: `0x${"0a".repeat(32)}`,
        walletAddress: `0x${"0b".repeat(32)}`,
      },
      ...[0, 1, 2].map((index) => ({
        index,
        role: "local_user" as const,
        publicKey: `0x${String(index + 1).padStart(64, "0")}`,
        walletAddress: `0x${String(index + 4).padStart(64, "0")}`,
      })),
    ],
    bootstrap: {
      devWallet: {
        deployEntrypoint: "0x0000000000000000",
        doActionEntrypoint: "0x0101010101010101",
      },
      storageCostModel: {
        hash: "0x7fcd5d27353800caf9f8f3a73a030be49a1dcd9db4616792e7887746bea713ce",
        baseDataItemCost: "12000",
        bytestringCostPerByte: "10",
        baseContractDeploymentCost: "12000",
        contractDeploymentCostPerByte: "10",
        authPerKeyCost: "1111",
        rcqCostPerEntry: "8",
        replayCacheCostPerEntry: "7",
        balanceCost: "1234",
      },
    },
  };
}

describe("validateRuntimeManifest", () => {
  it("accepts the pinned fresh local runtime", () => {
    expect(() => validateRuntimeManifest(manifest())).not.toThrow();
  });

  it("rejects changed costs and insufficient accounts", () => {
    const changed = manifest();
    changed.bootstrap.storageCostModel.balanceCost = "1235";
    expect(() => validateRuntimeManifest(changed)).toThrow(
      /pinned local runtime/,
    );
    const insufficient = manifest();
    insufficient.bootstrapAccounts.pop();
    expect(() => validateRuntimeManifest(insufficient)).toThrow(
      /Alice, Bob, and Carol/,
    );
    const noFaucet = manifest();
    noFaucet.bootstrapAccounts = noFaucet.bootstrapAccounts.filter(
      ({ role }) => role !== "faucet",
    );
    expect(() => validateRuntimeManifest(noFaucet)).toThrow(/faucet/);
  });
});

describe("validateLocalRpcUrl", () => {
  it("accepts loopback HTTP and rejects remote or credentialed targets", () => {
    expect(validateLocalRpcUrl("http://127.0.0.1:9545")).toBe(
      "http://127.0.0.1:9545/",
    );
    expect(() => validateLocalRpcUrl("http://rpc.example.com")).toThrow(
      /loopback HTTP/,
    );
    expect(() => validateLocalRpcUrl("https://localhost:9545")).toThrow(
      /loopback HTTP/,
    );
    expect(() =>
      validateLocalRpcUrl("http://user:secret@localhost:9545"),
    ).toThrow(/loopback HTTP/);
  });
});

describe("validateWireFormat", () => {
  it("accepts stable wire 4 releases and rejects other majors", () => {
    expect(() => validateWireFormat("4.0.0")).not.toThrow();
    expect(() => validateWireFormat("4.12.3")).not.toThrow();
    for (const value of ["3.9.0", "5.0.0", "4.0.0-rc.1", "invalid"]) {
      expect(() => validateWireFormat(value)).toThrow(/wire format 4.x/);
    }
  });
});

describe("renderEnvironment", () => {
  it("renders every browser setting and disposable persona", () => {
    const environment = renderEnvironment({
      rpcUrl: "http://127.0.0.1:9545",
      networkHash: `0x${"11".repeat(32)}`,
      walletEntrypoint: "0x0101010101010101",
      nativeHogAddress: contractAddress(new Uint8Array(32).fill(2)),
      factoryAddress: contractAddress(new Uint8Array(32).fill(3)),
      tokenHash: new Uint8Array(32).fill(4),
      personas: [
        {
          id: "alice",
          label: "Alice",
          accountAddress: `0x${"05".repeat(32)}`,
          privateKey: `0x${"06".repeat(32)}`,
        },
      ],
    });
    expect(environment).toContain("VITE_NATIVE_BALANCE_ITEM_COST=1234");
    expect(environment).toContain(
      `VITE_STANDARD_TOKEN_HASH=0x${"04".repeat(32)}`,
    );
    expect(environment).toContain('GROUNDHOG_DEV_PERSONAS=[{"id":"alice"');
  });
});
