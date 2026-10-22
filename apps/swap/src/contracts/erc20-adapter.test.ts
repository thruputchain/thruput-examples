import { contractAddress } from "@thruputchain/protocol";
import {
  CxsWriter,
  OptionCodec,
  Uint128Codec,
  Uint32Codec,
  type XdrCodec,
} from "@thruputchain/xdr";
import { describe, expect, it, vi } from "vitest";

import { createErc20ReadAdapter } from "./erc20-adapter";

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));

describe("createErc20ReadAdapter", () => {
  it("reads a balance with the configured contract and caller", async () => {
    const view = vi.fn().mockResolvedValue(response(Uint8Array.from([0, 42])));
    const contract = address(1);
    const caller = address(2);
    const owner = address(3);
    const adapter = createErc20ReadAdapter({
      client: { simulateInvocation: view },
      contract,
      caller,
    });

    await expect(adapter.balanceOf(owner)).resolves.toEqual({
      value: 42n,
      stateBlockHeight: 1n,
      events: [],
    });
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({ address: contract, caller }),
    );
  });

  it("decodes allowance and optional metadata", async () => {
    const view = vi
      .fn()
      .mockResolvedValueOnce(response(encode(Uint128Codec, 7n)))
      .mockResolvedValueOnce(response(encodeOptionalString("Thruput")))
      .mockResolvedValueOnce(response(encodeOptionalString("THRU")))
      .mockResolvedValueOnce(response(encode(OptionCodec(Uint32Codec), 6n)));
    const adapter = createErc20ReadAdapter({
      client: { simulateInvocation: view },
      contract: address(1),
      caller: address(2),
    });

    await expect(adapter.allowance(address(3), address(4))).resolves.toEqual({
      value: 7n,
      stateBlockHeight: 1n,
      events: [],
    });
    await expect(adapter.metadata()).resolves.toEqual({
      name: { value: "Thruput", stateBlockHeight: 1n, events: [] },
      symbol: { value: "THRU", stateBlockHeight: 1n, events: [] },
      decimals: { value: 6, stateBlockHeight: 1n, events: [] },
    });
  });

  it("surfaces metadata read failures instead of changing token scale", async () => {
    const view = vi
      .fn()
      .mockRejectedValueOnce(new Error("name unavailable"))
      .mockResolvedValueOnce(response(encodeOptionalString("THRU")))
      .mockResolvedValueOnce(response(encode(OptionCodec(Uint32Codec), 18n)));
    const adapter = createErc20ReadAdapter({
      client: { simulateInvocation: view },
      contract: address(1),
      caller: address(2),
    });

    await expect(adapter.metadata()).rejects.toThrow("name unavailable");
  });
});

function response(returnData: Uint8Array) {
  return {
    output: { result: "return" as const, returnData },
    events: [],
    stateBlockHeight: 1n,
  };
}

function encode<T>(codec: XdrCodec<T>, value: T): Uint8Array {
  const writer = new CxsWriter();
  codec.encode(writer, value);
  return writer.finish();
}

function encodeOptionalString(value: string | null): Uint8Array {
  const writer = new CxsWriter();
  writer.writeUint32(value === null ? 0n : 1n);
  if (value !== null) writer.writeString(value, 0xffffffff);
  return writer.finish();
}
