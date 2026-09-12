import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  MAX_POOL_TOKEN_ARTIFACT_BYTES,
  parsePoolTokenArtifact,
  poolTokenArtifactPath,
} from "../src/transactions/pool-token-artifact.ts";

/** Validate the exact public asset that the build or HTTP server will serve. */
export async function verifyPoolTokenArtifact(
  directory: string,
  expectedHash: string | undefined,
): Promise<void> {
  const relativePath = poolTokenArtifactPath(expectedHash);
  const root = await realpath(directory);
  let filename: string;
  try {
    filename = await realpath(path.join(root, relativePath));
  } catch {
    throw new Error(`Pool token artifact is missing: ${relativePath}`);
  }
  const relative = path.relative(root, filename);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Pool token artifact must be inside the public directory");
  }
  const file = await open(filename, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_POOL_TOKEN_ARTIFACT_BYTES) {
      throw new Error(
        "Pool token artifact must be a file no larger than 8 MiB",
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_POOL_TOKEN_ARTIFACT_BYTES)
        throw new Error("Pool token artifact is too large");
      chunks.push(chunk);
    }
    parsePoolTokenArtifact(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      expectedHash!,
    );
  } finally {
    await file.close();
  }
}
