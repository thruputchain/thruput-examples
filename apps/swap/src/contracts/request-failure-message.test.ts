import { describe, expect, it } from "vitest";

import { requestFailureMessage } from "./failure-message";
import { batch_driver } from "./generated/swap-driver";

const Cause = batch_driver.v0_1.events.Cause;
type Cause = batch_driver.v0_1.events.Cause;
type RequestFailed = batch_driver.v0_1.events.RequestFailed;

const slippage: RequestFailed["fields"] = {
  cause: Cause.Exception,
  selector: 0x947bdd51feea1ccen,
  payload: Uint8Array.of(3),
  payload_len: 1n,
};

describe("requestFailureMessage", () => {
  it("decodes the handler's slippage exception", () => {
    expect(requestFailureMessage(slippage)).toBe(
      "Slippage limit exceeded: output was below your minimum received amount.",
    );
  });

  it("distinguishes library errors from request errors with the same code", () => {
    expect(requestFailureMessage({ ...slippage, selector: 0x17e7e152700d9279n }))
      .toBe("The swap input amount is insufficient.");
  });

  it.each([
    { selector: 1n },
    { payload_len: 8n },
    { payload: new Uint8Array(), payload_len: 0n },
    { payload: Uint8Array.of(99) },
  ])("falls back for unknown or incomplete exceptions: %s", (fields) => {
    expect(requestFailureMessage({ ...slippage, ...fields })).toBeNull();
  });

  it.each([
    [Cause.Fault, "Request execution failed (gas limit or contract error)."],
    [Cause.Rejected, "The handler call was rejected."],
    [Cause.Malformed, "The contract request or response could not be decoded."],
  ])("describes cause %s without decoding exception fields", (cause, message) => {
    expect(requestFailureMessage({ ...slippage, cause })).toBe(message);
  });
});
