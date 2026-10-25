// @vitest-environment node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deriveContractAddress, toHex0x } from "@thruputchain/client";
import { fromHex } from "@thruputchain/protocol/utils";
import { contractAddress, sha256Hash } from "@thruputchain/protocol";
import { CxsWriter } from "@thruputchain/xdr";
import { expect, it } from "vitest";

it("derives factory child addresses matching the Rust vectors", async () => {
  const vectors: {
    factory: string;
    creator: string;
    application_nonce: string;
    token_hash: string;
    deployment_nonce: string;
    child_address: string;
  }[] = JSON.parse(
    await readFile(
      new URL(
        "../../../../interfaces/standard-token-factory-if/tests/fixtures/address-vectors.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(vectors).toHaveLength(4);
  for (const vector of vectors) {
    const writer = new CxsWriter();
    writer.writeString("thruput-standard-token-factory-v1", 0xffff_ffff);
    writer.writeFixedOpaque(fromHex(vector.creator), 32);
    writer.writeFixedOpaque(fromHex(vector.application_nonce), 32);
    const nonce = sha256Hash(
      createHash("sha256").update(writer.finish()).digest(),
    );
    expect(toHex0x(nonce).slice(2)).toBe(vector.deployment_nonce);
    const child = deriveContractAddress(
      contractAddress(fromHex(vector.factory)),
      nonce,
      sha256Hash(fromHex(vector.token_hash)),
    );
    expect(toHex0x(child).slice(2)).toBe(vector.child_address);
  }
});
