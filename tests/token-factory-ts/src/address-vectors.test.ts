import { readFile } from "node:fs/promises";

import { deriveContractAddress } from "@groundhogchain/client/contract";
import { contractAddress, sha256Hash } from "@groundhogchain/protocol";
import { fromHex, toHex } from "@groundhogchain/protocol/utils";
import { serializeCxs, type XdrCodec } from "@groundhogchain/xdr";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

interface AddressVector {
  factory: string;
  creator: string;
  application_nonce: string;
  token_hash: string;
  deployment_nonce: string;
  child_address: string;
}

interface DeploymentNoncePreimage {
  domain: string;
  creator: Uint8Array;
  nonce: Uint8Array;
}

const deploymentDomain = "groundhog-standard-token-factory-v1";
const deploymentNonceCodec: XdrCodec<DeploymentNoncePreimage> = {
  encode(writer, value) {
    writer.writeString(value.domain, 0xffff_ffff);
    writer.writeFixedOpaque(value.creator, 32);
    writer.writeFixedOpaque(value.nonce, 32);
  },
  decode() {
    throw new Error("Deployment nonce preimages are encode-only");
  },
};

function deriveDeploymentNonce(creator: Uint8Array, nonce: Uint8Array) {
  return sha256Hash(
    sha256(
      serializeCxs(
        { domain: deploymentDomain, creator, nonce },
        deploymentNonceCodec,
      ),
    ),
  );
}

describe("standard token factory address vectors", () => {
  it("matches every Rust vector byte for byte", async () => {
    const vectors = JSON.parse(
      await readFile(
        new URL(
          "../../../interfaces/standard-token-factory-if/tests/fixtures/address-vectors.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as AddressVector[];

    expect(vectors).toHaveLength(4);
    for (const vector of vectors) {
      const creator = contractAddress(fromHex(vector.creator));
      const deploymentNonce = deriveDeploymentNonce(
        creator,
        fromHex(vector.application_nonce),
      );
      expect(toHex(deploymentNonce)).toBe(vector.deployment_nonce);

      const child = deriveContractAddress(
        contractAddress(fromHex(vector.factory)),
        deploymentNonce,
        sha256Hash(fromHex(vector.token_hash)),
      );
      expect(toHex(child)).toBe(vector.child_address);
    }
  });
});
