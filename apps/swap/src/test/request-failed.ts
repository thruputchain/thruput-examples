import type { EmittedEvent } from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import {
  CxsWriter,
  Int32Codec,
  Uint32Codec,
  Uint64Codec,
  VarOpaqueCodec,
} from "@thruputchain/xdr";
import { batch_driver } from "../contracts/generated/swap-driver";

const Cause = batch_driver.v0_1.events.Cause;
type Cause = batch_driver.v0_1.events.Cause;
const RequestFailed = batch_driver.v0_1.events.RequestFailed;
type RequestFailed = batch_driver.v0_1.events.RequestFailed;

/** Wire fixture for the batch-driver failure event, including its diagnostic payload. */
export function requestFailedEvent(
  contractAddress: ContractAddress,
  requestId: Uint8Array,
  fields: RequestFailed["fields"] = {
    cause: Cause.Exception,
    selector: 1n,
    payload: Uint8Array.of(1),
    payload_len: 1n,
  },
): EmittedEvent {
  const writer = new CxsWriter();
  Int32Codec.encode(writer, fields.cause);
  Uint64Codec.encode(writer, fields.selector);
  VarOpaqueCodec(256).encode(writer, fields.payload);
  Uint32Codec.encode(writer, fields.payload_len);
  return {
    contractAddress,
    topics: [RequestFailed.signature, requestId],
    data: writer.finish(),
  };
}
