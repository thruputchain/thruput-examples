import {
  bytesEqual,
  fromHex0x,
  hashContract,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";
import { ContractType, type Contract } from "@thruputchain/protocol";

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Fetch only on creation. Never accept an artifact URL from config or a provider. */
export async function loadStandardTokenArtifact(
  expectedHash: Uint8Array,
): Promise<Contract> {
  const response = await fetch(
    new URL(
      `${import.meta.env.BASE_URL}contract-artifacts/${toBase58(expectedHash)}.json`,
      window.location.origin,
    ),
    {
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok || !response.body)
    throw new Error("Standard token deployment artifact is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ARTIFACT_BYTES)
        throw new Error("Standard token deployment artifact is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return parseStandardTokenArtifact(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    expectedHash,
  );
}

export function parseStandardTokenArtifact(
  value: unknown,
  expectedHash: Uint8Array,
): Contract {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 3 ||
    !("contractType" in value) ||
    value.contractType !== "rv32" ||
    !("data" in value) ||
    typeof value.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.data) ||
    !("hash" in value) ||
    typeof value.hash !== "string" ||
    value.hash !== toBase58(expectedHash)
  ) {
    throw new Error("Standard token deployment artifact is invalid");
  }
  const contract: Contract = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: fromHex0x(value.data) },
  };
  if (
    !bytesEqual(hashContract(contract), expectedHash) ||
    !bytesEqual(hashFromBase58(value.hash), expectedHash)
  )
    throw new Error(
      "Standard token deployment artifact hash does not match configuration",
    );
  return contract;
}
