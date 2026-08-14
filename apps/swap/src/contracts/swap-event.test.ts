import { contractAddress, ExecResult, sha256Hash } from "@groundhogchain/protocol";
import { CxsWriter, FixedArrayCodec, Uint128Codec } from "@groundhogchain/xdr";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import {
  decodeRequestFailed,
  decodeSwapEvent,
  extractAcceptedRequestId,
  REQUEST_ACCEPTED_SIGNATURE,
  REQUEST_FAILED_SIGNATURE,
  SWAP_EVENT_SIGNATURE,
} from "./swap-event";

const AmountsCodec = FixedArrayCodec(Uint128Codec, 2);

describe("swap lifecycle events", () => {
  it.each([
    [SWAP_EVENT_SIGNATURE, "0.1::swap-if::SwapEvent"],
    [REQUEST_ACCEPTED_SIGNATURE, "0.1::swap-if::RequestAccepted"],
    [REQUEST_FAILED_SIGNATURE, "0.1::swap-if::RequestFailed"],
  ])("matches the generated signature for %s", (signature, preimage) => {
    expect(signature).toEqual(sha256(new TextEncoder().encode(preimage)));
  });

  it("decodes amounts and request ID from the current SwapEvent layout", () => {
    const writer = new CxsWriter();
    AmountsCodec.encode(writer, [7n, 0n]);
    AmountsCodec.encode(writer, [0n, 5n]);
    writer.writeUint32(1n);
    writer.writeFixedOpaque(new Uint8Array(32).fill(3), 32);

    expect(
      decodeSwapEvent({
        topics: [
          SWAP_EVENT_SIGNATURE,
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(2),
        ],
        data: writer.finish(),
      }),
    ).toEqual({
      sender: new Uint8Array(32).fill(1),
      recipient: new Uint8Array(32).fill(2),
      amountsIn: [7n, 0n],
      amountsOut: [0n, 5n],
      requestId: new Uint8Array(32).fill(3),
    });
  });

  it("strictly decodes request failure and accepted receipt framing", () => {
    const requestId = new Uint8Array(32).fill(4);
    expect(
      decodeRequestFailed({
        topics: [REQUEST_FAILED_SIGNATURE, requestId],
        data: new Uint8Array(),
      }),
    ).toEqual(requestId);

    const driver = contractAddress(new Uint8Array(32).fill(5));
    expect(
      extractAcceptedRequestId(
        {
          txHash: sha256Hash(new Uint8Array(32)),
          height: 8n,
          execResult: ExecResult.ExecResultOK,
          events: [
            {
              contractAddress: driver,
              topics: [REQUEST_ACCEPTED_SIGNATURE, requestId],
              data: new Uint8Array(),
            },
          ],
          returnData: null,
          abortData: null,
        },
        driver,
      ),
    ).toEqual(requestId);
  });

  it("rejects missing, duplicate, and malformed accepted request IDs", () => {
    const driver = contractAddress(new Uint8Array(32).fill(5));
    const event = {
      contractAddress: driver,
      topics: [REQUEST_ACCEPTED_SIGNATURE, new Uint8Array(32)],
      data: new Uint8Array(),
    };
    const receipt = {
      txHash: sha256Hash(new Uint8Array(32)),
      height: 8n,
      execResult: ExecResult.ExecResultOK,
      events: [event, event],
      returnData: null,
      abortData: null,
    };

    expect(() => extractAcceptedRequestId(receipt, driver)).toThrow(
      "received 2",
    );
    expect(() =>
      extractAcceptedRequestId({ ...receipt, events: [] }, driver),
    ).toThrow("received 0");
    expect(() =>
      extractAcceptedRequestId(
        {
          ...receipt,
          events: [{ ...event, topics: [REQUEST_ACCEPTED_SIGNATURE, new Uint8Array(31)] }],
        },
        driver,
      ),
    ).toThrow("32 bytes");
  });
});
