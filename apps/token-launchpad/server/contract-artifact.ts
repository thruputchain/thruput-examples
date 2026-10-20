import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { hashFromBase58, toBase58 } from "@thruputchain/client";
import {
  MAX_ARTIFACT_BYTES,
  parseStandardTokenArtifact,
} from "../src/contracts/token-artifact.ts";

/** Read-only validation shared by production builds and server startup. */
export async function validateStandardTokenArtifact(
  directory: string,
  hash: string | undefined,
): Promise<void> {
  let expectedHash: Uint8Array;
  try {
    expectedHash = hashFromBase58(hash ?? "");
  } catch {
    throw new Error("VITE_STANDARD_TOKEN_HASH must be a 32-byte base58 hash");
  }
  const root = await realpath(directory);
  let filename: string;
  try {
    filename = await realpath(
      path.join(root, "contract-artifacts", `${toBase58(expectedHash)}.json`),
    );
  } catch {
    throw new Error("Required standard token deployment artifact is missing");
  }
  if (!filename.startsWith(`${root}${path.sep}`))
    throw new Error(
      "Standard token deployment artifact must be inside the served directory",
    );
  const file = await open(filename, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES)
      throw new Error(
        "Standard token deployment artifact is invalid or too large",
      );
    const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_ARTIFACT_BYTES)
      throw new Error("Standard token deployment artifact is too large");
    parseStandardTokenArtifact(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ),
      expectedHash,
    );
  } finally {
    await file.close();
  }
}
