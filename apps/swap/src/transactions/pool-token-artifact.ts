import {
  fromHex0x,
  hashContract,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";
import { ContractType, type Contract } from "@thruputchain/protocol";

export const MAX_POOL_TOKEN_ARTIFACT_BYTES = 8 * 1024 * 1024;

export function poolTokenArtifactPath(
  expectedHash: string | undefined,
): string {
  if (!expectedHash || !isCanonicalHash(expectedHash)) {
    throw new Error(
      "VITE_POOL_TOKEN_HASH must be a canonical base58 32-byte hash",
    );
  }
  return `contract-artifacts/${expectedHash}.json`;
}

export function parsePoolTokenArtifact(
  value: unknown,
  expectedHash: string,
): Contract {
  poolTokenArtifactPath(expectedHash);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("contractType" in value) ||
    value.contractType !== "rv32" ||
    !("data" in value) ||
    typeof value.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.data) ||
    !("hash" in value) ||
    value.hash !== expectedHash
  ) {
    throw new Error(
      "Pool token artifact is invalid or its hash does not match VITE_POOL_TOKEN_HASH",
    );
  }
  const contract: Contract = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: fromHex0x(value.data) },
  };
  if (toBase58(hashContract(contract)) !== expectedHash)
    throw new Error("Pool token artifact hash mismatch");
  return contract;
}

function isCanonicalHash(value: string): boolean {
  try {
    return toBase58(hashFromBase58(value)) === value;
  } catch {
    return false;
  }
}

export async function fetchPoolTokenArtifact(
  expectedHash: string | undefined,
): Promise<Contract> {
  const artifactPath = poolTokenArtifactPath(expectedHash);
  const response = await fetch(
    new URL(
      `${import.meta.env.BASE_URL}${artifactPath}`,
      window.location.origin,
    ),
    {
      redirect: "error",
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Pool token artifact is unavailable");
  }
  const reader = response.body.getReader();
  try {
    if (
      Number(response.headers.get("content-length")) >
      MAX_POOL_TOKEN_ARTIFACT_BYTES
    )
      throw new Error("Pool token artifact is too large");
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_POOL_TOKEN_ARTIFACT_BYTES)
        throw new Error("Pool token artifact is too large");
      text += decoder.decode(value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    return parsePoolTokenArtifact(value, expectedHash!);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
