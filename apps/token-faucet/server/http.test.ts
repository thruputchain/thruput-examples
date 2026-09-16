import { fileURLToPath } from "node:url";
import { HttpResponseError, JsonRpcError } from "@groundhogchain/client";
import { afterEach, expect, it, vi } from "vitest";
import { SeedError } from "../../../scripts/seed/seed-journal.ts";
import type { ClaimStatus } from "../src/domain.ts";
import { readManifest } from "./config";
import { faucetServer } from "./http";

afterEach(() => vi.restoreAllMocks());
const manifest = await readManifest(
  fileURLToPath(new URL("../deployments/devnet.json", import.meta.url)),
);
const recipient = `0x${"03".repeat(32)}`;
const hash = `0x${"04".repeat(32)}`;
const secret = "DO_NOT_LOG_PRIVATE_KEY_OR_SIGNED_BYTES";

async function failedClaim(
  error: unknown,
  status = vi.fn(async (): Promise<ClaimStatus> => ({
    state: "pending",
    transactionHash: hash,
  })),
) {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const server = faucetServer(
    manifest,
    { claim: vi.fn().mockRejectedValue(error), status },
    "/unused",
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/claims`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: manifest.tokens[0]!.address,
          address: recipient,
        }),
      },
    );
    expect(response.status).toBe(503);
    return { body: await response.json(), log };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

it("logs an unresolved journal failure with token, recipient and recorded hash", async () => {
  const message =
    "Expired unresolved transaction; preserve journal and investigate original hash";
  const { body, log } = await failedClaim(
    new SeedError(message, { cause: secret }),
  );
  expect(log).toHaveBeenCalledWith(
    "Faucet claim failed",
    expect.objectContaining({
      token: manifest.tokens[0]!.address,
      recipient,
      transactionHash: hash,
      error: { kind: "journal", message, operatorActionRequired: true },
    }),
  );
  expect(body.error).toContain("investigation by the faucet operator");
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(body)).not.toContain(message);
});

it.each([
  [
    new JsonRpcError(-32050, secret, { signedTransaction: secret }),
    { kind: "rpc", code: -32050, operatorActionRequired: false },
  ],
  [
    new JsonRpcError(-32001, secret),
    { kind: "rpc", code: -32001, operatorActionRequired: false },
  ],
  [
    new HttpResponseError(503, secret),
    { kind: "http", status: 503, operatorActionRequired: false },
  ],
  [
    new Error(secret, { cause: { privateKey: secret } }),
    { kind: "Error", operatorActionRequired: false },
  ],
])(
  "logs safe diagnostics for %s without external messages or payloads",
  async (error, expected) => {
    const { body, log } = await failedClaim(error);
    expect(log).toHaveBeenCalledWith(
      "Faucet claim failed",
      expect.objectContaining({ error: expected, transactionHash: hash }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.error).toContain("Retry to check the same claim");
  },
);

it("reports corrupt journals without logging their contents or losing the original error", async () => {
  const status = vi.fn(async (): Promise<ClaimStatus> => {
    throw new SyntaxError(secret);
  });
  const { body, log } = await failedClaim(new SyntaxError(secret), status);
  expect(log).toHaveBeenCalledWith(
    "Faucet claim failed",
    expect.objectContaining({
      transactionHash: undefined,
      error: { kind: "invalidJson", operatorActionRequired: true },
      statusError: { kind: "invalidJson", operatorActionRequired: true },
    }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(body.error).toContain("investigation by the faucet operator");
});

it("does not log malformed transaction hashes from a damaged journal", async () => {
  const status = vi.fn(async (): Promise<ClaimStatus> => ({
    state: "pending",
    transactionHash: secret,
  }));
  const { log } = await failedClaim(new Error(secret), status);
  expect(log).toHaveBeenCalledWith(
    "Faucet claim failed",
    expect.objectContaining({ transactionHash: undefined }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
});
