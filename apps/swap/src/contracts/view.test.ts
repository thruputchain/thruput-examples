import { buildNamedCodecs, resolveCodec } from "@groundhogchain/client";
import { contractAddress, gasAmount } from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { describe, expect, it, vi } from "vitest";

import { ERC20, ERC20Error, spec } from "@/contracts/generated/erc20";

import { decodeContractAbort, decodeMethodReturn, viewMethod } from "./view";

const address = contractAddress(new Uint8Array(32));
const invocation = ERC20.getBalanceOf(address, gasAmount(1n), { addr: address });

describe("decodeMethodReturn", () => {
  it("strictly decodes a generated method return", () => {
    const encoded = encodeReturn("ERC20", "get_balance_of", 42n);

    expect(decodeMethodReturn(spec, "ERC20", "get_balance_of", encoded)).toBe(
      42n,
    );
    expect(() =>
      decodeMethodReturn(
        spec,
        "ERC20",
        "get_balance_of",
        Uint8Array.from([...encoded, 0]),
      ),
    ).toThrow("trailing bytes");
  });
});

describe("viewMethod", () => {
  it("returns a validated value", async () => {
    const client = {
      view: vi.fn().mockResolvedValue({
        output: {
          result: "return",
          returnData: encodeReturn("ERC20", "get_balance_of", 42n),
        },
        events: [],
        height: 1n,
      }),
    };

    await expect(
      viewMethod({
        client,
        invocation,
        caller: address,
        spec,
        interfaceName: "ERC20",
        methodName: "get_balance_of",
        validate: (value) => value as bigint,
      }),
    ).resolves.toBe(42n);
  });

  it.each([
    [{ result: "abort", abortData: new Uint8Array([1]) }, "abort"],
    [{ result: "fault" }, "fault"],
  ] as const)("preserves the %s outcome", async (output, kind) => {
    const client = {
      view: vi.fn().mockResolvedValue({ output, events: [], height: 1n }),
    };

    const promise = viewMethod({
      client,
      invocation,
      caller: address,
      spec,
      interfaceName: "ERC20",
      methodName: "get_balance_of",
      validate: (value) => value,
    });

    await expect(promise).rejects.toMatchObject({ kind });
  });
});

describe("decodeContractAbort", () => {
  it("decodes a declared exception selector and payload", () => {
    const exception = spec.interfaces[0]!.throws[0]!;
    const writer = new CxsWriter();
    writer.writeUint64(exception.selector);
    resolveCodec(exception.ty, buildNamedCodecs(spec.type_defs)).encode(
      writer,
      ERC20Error.TooLarge,
    );

    expect(
      decodeContractAbort(spec, "ERC20", writer.finish()),
    ).toMatchObject({
      kind: "declared",
      selector: exception.selector,
      exceptionName: "ERC20Error",
      value: BigInt(ERC20Error.TooLarge),
    });
  });
});

function encodeReturn(
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
