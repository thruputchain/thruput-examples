import { buildNamedCodecs, resolveCodec } from "@groundhogchain/client";
import { contractAddress } from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { describe, expect, it, vi } from "vitest";

import { spec } from "@/contracts/generated/erc20";

import { createErc20ReadAdapter } from "./erc20-adapter";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

describe("createErc20ReadAdapter", () => {
  it("reads a balance with the configured contract and caller", async () => {
    const view = vi.fn().mockResolvedValue(response(Uint8Array.from([0, 42])));
    const contract = address(1);
    const caller = address(2);
    const owner = address(3);
    const adapter = createErc20ReadAdapter({ client: { view }, contract, caller });

    await expect(adapter.balanceOf(owner)).resolves.toBe(42n);
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({ contract, caller }),
    );
  });

  it("decodes allowance and optional metadata", async () => {
    const view = vi
      .fn()
      .mockResolvedValueOnce(response(encode("ERC20", "allowance", 7n)))
      .mockResolvedValueOnce(
        response(encode("ERC20Metadata", "name", "Groundhog")),
      )
      .mockResolvedValueOnce(
        response(encode("ERC20Metadata", "symbol", "HOG")),
      )
      .mockResolvedValueOnce(
        response(encode("ERC20Metadata", "decimals", 6n)),
      );
    const adapter = createErc20ReadAdapter({
      client: { view },
      contract: address(1),
      caller: address(2),
    });

    await expect(adapter.allowance(address(3), address(4))).resolves.toBe(7n);
    await expect(adapter.metadata()).resolves.toEqual({
      name: "Groundhog",
      symbol: "HOG",
      decimals: 6,
    });
  });
});

function response(returnData: Uint8Array) {
  return {
    output: { result: "return" as const, returnData },
    events: [],
    height: 1n,
  };
}

function encode(
  interfaceName: string,
  methodName: string,
  value: unknown,
): Uint8Array {
  const contractInterface = spec.interfaces.find(
    (candidate) => String(candidate.name) === interfaceName,
  )!;
  const method = contractInterface.methods.find(
    (candidate) => String(candidate.name) === methodName,
  )!;
  const writer = new CxsWriter();
  resolveCodec(method.return_type, buildNamedCodecs(spec.type_defs)).encode(
    writer,
    value,
  );
  return writer.finish();
}
