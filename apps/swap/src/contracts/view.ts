import {
  buildNamedCodecs,
  resolveCodec,
  type ContractSpec,
  type GroundhogClient,
} from "@groundhogchain/client";
import type { ContractAddress, Invocation } from "@groundhogchain/protocol";
import { CxsReader } from "@groundhogchain/xdr";

export class ContractViewError extends Error {
  constructor(
    readonly kind: "abort" | "fault",
    readonly data: Uint8Array | null,
    readonly decodedAbort: DecodedContractAbort | null = null,
  ) {
    super(kind === "abort" ? "Contract view aborted" : "Contract view faulted");
    this.name = "ContractViewError";
  }
}

export type DecodedContractAbort =
  | {
      kind: "declared";
      selector: bigint;
      exceptionName: string | null;
      value: unknown;
    }
  | { kind: "unknown"; selector: bigint };

export async function viewMethod<T>(params: {
  client: Pick<GroundhogClient, "view">;
  invocation: Invocation;
  caller: ContractAddress;
  spec: ContractSpec;
  interfaceName: string;
  methodName: string;
  validate: (value: unknown) => T;
}): Promise<T> {
  const response = await params.client.view({
    contract: params.invocation.invoked_address,
    entrypoint: params.invocation.entrypoint,
    calldata: params.invocation.calldata,
    caller: params.caller,
  });

  if (response.output.result === "abort") {
    throw new ContractViewError(
      "abort",
      response.output.abortData,
      tryDecodeContractAbort(
        params.spec,
        params.interfaceName,
        response.output.abortData,
      ),
    );
  }
  if (response.output.result === "fault") {
    throw new ContractViewError("fault", null);
  }

  return params.validate(
    decodeMethodReturn(
      params.spec,
      params.interfaceName,
      params.methodName,
      response.output.returnData,
    ),
  );
}

export function decodeContractAbort(
  spec: ContractSpec,
  interfaceName: string,
  data: Uint8Array,
): DecodedContractAbort {
  const contractInterface = findInterface(spec, interfaceName);
  const reader = new CxsReader(data);
  const selector = reader.readUint64();
  const exception = contractInterface.throws.find(
    (candidate) => candidate.selector === selector,
  );
  if (exception === undefined) {
    return { kind: "unknown", selector };
  }

  const value = resolveCodec(
    exception.ty,
    buildNamedCodecs(spec.type_defs),
  ).decode(reader);
  if (reader.remaining !== 0) {
    throw new Error(
      `${interfaceName} abort returned ${reader.remaining} trailing bytes`,
    );
  }
  return {
    kind: "declared",
    selector,
    exceptionName:
      "named" in exception.ty ? String(exception.ty.named) : null,
    value,
  };
}

export function decodeMethodReturn(
  spec: ContractSpec,
  interfaceName: string,
  methodName: string,
  data: Uint8Array,
): unknown {
  const contractInterface = findInterface(spec, interfaceName);
  const method = contractInterface.methods.find(
    (candidate) => String(candidate.name) === methodName,
  );
  if (method === undefined) {
    throw new Error(`Unknown contract method: ${interfaceName}.${methodName}`);
  }

  const reader = new CxsReader(data);
  const value = resolveCodec(
    method.return_type,
    buildNamedCodecs(spec.type_defs),
  ).decode(reader);
  if (reader.remaining !== 0) {
    throw new Error(
      `${interfaceName}.${methodName} returned ${reader.remaining} trailing bytes`,
    );
  }
  return value;
}

function findInterface(spec: ContractSpec, interfaceName: string) {
  const contractInterface = spec.interfaces.find(
    (candidate) => String(candidate.name) === interfaceName,
  );
  if (contractInterface === undefined) {
    throw new Error(`Unknown contract interface: ${interfaceName}`);
  }
  return contractInterface;
}

function tryDecodeContractAbort(
  spec: ContractSpec,
  interfaceName: string,
  data: Uint8Array,
): DecodedContractAbort | null {
  try {
    return decodeContractAbort(spec, interfaceName, data);
  } catch {
    return null;
  }
}

export function expectBigint(value: unknown, method: string): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${method} did not return a bigint`);
  }
  return value;
}
