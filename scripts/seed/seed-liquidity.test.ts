// @vitest-environment node
import { expect, it } from "vitest";
import type { TransactionReceipt } from "@thruputchain/client";
import {
  contractAddress,
  ExecResult,
  sha256Hash,
} from "@thruputchain/protocol";
import { CxsWriter, Uint128Codec } from "@thruputchain/xdr";
import { swap_if } from "../../apps/swap/src/contracts/generated/swap-handler.ts";
import { assertLiquidityMint } from "./seed-liquidity.ts";

const handler = contractAddress(new Uint8Array(32).fill(1));
const owner = contractAddress(new Uint8Array(32).fill(2));
const request = new Uint8Array(32).fill(3);
function receipt(amount = 10n): TransactionReceipt {
  const writer = new CxsWriter();
  Uint128Codec.encode(writer, amount);
  writer.writeUint32(1n);
  writer.writeFixedOpaque(request, 32);
  return {
    transactionHash: sha256Hash(new Uint8Array(32)),
    blockHeight: 1n,
    gasUsed: 0n,
    execution: { result: "return" as const, returnData: new Uint8Array() },

    events: [
      {
        address: handler,
        topics: [
          swap_if.v0_1.events.LiquidityMintEvent.signature,
          owner,
          owner,
        ],
        data: writer.finish(),
      },
    ],
  };
}
it("requires the correlated mint, not just a successful crank", () => {
  expect(() =>
    assertLiquidityMint(receipt(), handler, request, owner, owner),
  ).not.toThrow();
  expect(() =>
    assertLiquidityMint(
      { ...receipt(), events: [] },
      handler,
      request,
      owner,
      owner,
    ),
  ).toThrow();
});
it("rejects another request, recipient, emitter, or a zero mint", () => {
  expect(() =>
    assertLiquidityMint(receipt(), handler, new Uint8Array(32), owner, owner),
  ).toThrow();
  expect(() =>
    assertLiquidityMint(receipt(), handler, request, owner, handler),
  ).toThrow();
  expect(() =>
    assertLiquidityMint(receipt(), owner, request, owner, owner),
  ).toThrow();
  expect(() =>
    assertLiquidityMint(receipt(0n), handler, request, owner, owner),
  ).toThrow();
});
