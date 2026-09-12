import { createHash } from "node:crypto";
import {
  bytesEqual,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";
import { serializeCxs, Uint32Codec, VarOpaqueCodec } from "@groundhogchain/xdr";
import { SeedError } from "./seed-journal.ts";
import { validateLocalRpcUrl } from "../../apps/token-launchpad/scripts/setup-local.ts";

export function seedTransport(url: string): HttpTransport {
  const fetch = globalThis.fetch.bind(globalThis);
  return new HttpTransport(validateLocalRpcUrl(url), {
    timeoutMs: 10_000,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
}

/** sdk 0.30 storage: SHA256(frame(CXS(domain)) || frame(CXS(slot))). */
export function seedStorageKey(domain: string, slot: number): Uint8Array {
  const frame = (bytes: Uint8Array) =>
    Buffer.concat([serializeCxs(BigInt(bytes.length), Uint32Codec), bytes]);
  return createHash("sha256")
    .update(frame(serializeCxs(Buffer.from(domain), VarOpaqueCodec(100))))
    .update(frame(serializeCxs(BigInt(slot), Uint32Codec)))
    .digest();
}

export async function verifySwapRelationship(
  client: Pick<GroundhogClient, "getStorageAt">,
  factory: ContractAddress,
  router: ContractAddress,
): Promise<void> {
  // No ABI getter or initialization event exists. These slots follow the pinned
  // #[storage] layout in contracts/swap-{factory,router}/src/{factory,router}.rs.
  // Factory.router is field 2; Router.cfg is field 0 and Cfg has only factory.
  // Both Value payloads are CXS fixed-opaque Address (exactly 32 bytes).
  for (const [contract, domain, slot, expected] of [
    [factory, "Factory", 2, router],
    [router, "Router", 0, factory],
  ] as const) {
    const { item } = await client.getStorageAt(
      contract,
      seedStorageKey(domain, slot),
    );
    if (item?.kind !== "bytestring" || !bytesEqual(item.bytes, expected)) {
      throw new SeedError(
        "Swap factory/router relationship mismatch or unsupported storage layout",
      );
    }
  }
}
