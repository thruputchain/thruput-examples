import { bytesEqual, fromHex0x } from "@groundhogchain/client";
import {
  LiquidityMintEvent as BaseMint,
  LiquidityBurnEvent as BaseBurn,
} from "./generated/swap-handler";

// The Rust event rename changed topic0, but not the topics or payload layout.
// Retain the deployed signatures while accepting freshly rebuilt contracts.
export const LiquidityMintEvent = withRenamedSignature(
  BaseMint,
  "0x48e990a9515a2084882012e9e7c7cf93100fd7f03be5f1665969aefe519444be",
  "0x972c26dc446a644066cd50d95bc7523ce1dd815f505dfc28cba88e00bcc771a7",
);
export const LiquidityBurnEvent = withRenamedSignature(
  BaseBurn,
  "0x44934a1f6a6a0d7c09f5464a14adefd9da1e9cde4d9420b333fecb917c47f52c",
  "0x3c2f1654cb81e61936b5544fd2ddec7c1ae881b4f6eca293cd21d0f3e5b999a3",
);

function withRenamedSignature<T extends typeof BaseMint | typeof BaseBurn>(
  descriptor: T,
  originalHex: string,
  renamedHex: string,
): T {
  const signatures = [fromHex0x(originalHex), fromHex0x(renamedHex)];
  const normalize = <E extends Parameters<T["decode"]>[0]>(event: E): E =>
    signatures.some((signature) =>
      bytesEqual(event.topics[0] ?? new Uint8Array(), signature),
    )
      ? { ...event, topics: [descriptor.signature, ...event.topics.slice(1)] }
      : event;
  return {
    ...descriptor,
    get signature() {
      return descriptor.signature;
    },
    decode: (event: Parameters<T["decode"]>[0]) =>
      descriptor.decode(normalize(event)),
    allFromReceipt: (...[receipt, scope]: Parameters<T["allFromReceipt"]>) =>
      descriptor.allFromReceipt(
        { ...receipt, events: receipt.events.map(normalize) },
        scope,
      ),
    singleFromReceipt: (
      ...[receipt, scope]: Parameters<T["singleFromReceipt"]>
    ) =>
      descriptor.singleFromReceipt(
        { ...receipt, events: receipt.events.map(normalize) },
        scope,
      ),
    filter: (input: Parameters<T["filter"]>[0]) => {
      const filter = descriptor.filter(input);
      return {
        ...filter,
        topics: {
          ...filter.topics,
          topic0: signatures.map((signature) => new Uint8Array(signature)),
        },
      };
    },
  } as T;
}
