import { HttpResponseError, JsonRpcError } from "@groundhogchain/client";
import { SeedError } from "../../../scripts/seed/seed-journal.ts";

/** Select diagnostic fields explicitly: RPC messages, causes and JSON parse errors can contain signed bytes. */
export function describeClaimError(error: unknown) {
  if (error instanceof SeedError) {
    // SeedError messages are authored locally by the transaction journal.
    return {
      kind: "journal",
      message: error.message,
      operatorActionRequired: true,
    };
  }
  if (error instanceof JsonRpcError) {
    return { kind: "rpc", code: error.code, operatorActionRequired: false };
  }
  if (error instanceof HttpResponseError) {
    return {
      kind: "http",
      status: error.status,
      operatorActionRequired: false,
    };
  }
  if (error instanceof SyntaxError) {
    return { kind: "invalidJson", operatorActionRequired: true };
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    [
      "EACCES",
      "EPERM",
      "ENOSPC",
      "EIO",
      "ENOENT",
      "EMFILE",
      "ENFILE",
      "EROFS",
    ].includes(error.code)
  ) {
    return {
      kind: "filesystem",
      code: error.code,
      operatorActionRequired: true,
    };
  }
  const kind =
    error instanceof Error &&
    ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError"].includes(
      error.name,
    )
      ? error.name
      : "UnknownError";
  return { kind, operatorActionRequired: false };
}
