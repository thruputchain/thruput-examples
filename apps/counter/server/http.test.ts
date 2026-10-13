import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addressFromHex,
  buildNamedCodecs,
  createPubkeyAccount,
  createTransaction,
  decodeCalldata,
  defaultWalletAdapter,
  deserializeSignedTransaction,
  fromHex0x,
  hashFromHex,
  hashSignedTransaction,
  PrivateKeySigner,
  serializeSignedTransaction,
  signTransaction,
  toHex0x,
} from "@thruputchain/client";
import {
  DefaultWallet,
  DefaultWalletSpec,
  ERC20,
  type default_wallet,
} from "@thruputchain/client/contracts";
import {
  blockHeight,
  ContractType,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  type Invocation,
} from "@thruputchain/protocol";
import { Counter, spec } from "../src/contracts/generated/counter";
import { loadServerConfig } from "./config";
import { createApiHandler } from "./http";
import { createCounterServer } from "./main";

const key = "22".repeat(32);
const environment = {
  VITE_GROUNDHOG_NETWORK_ID: "00".repeat(32),
  VITE_COUNTER_ADDRESS: "11".repeat(32),
  COUNTER_SIGNING_PRIVATE_KEY: key,
  VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
};
const config = loadServerConfig(environment);
const account = createPubkeyAccount({
  signer: new PrivateKeySigner(fromHex0x(`0x${key}`)),
});
const expectedNetwork = networkHash(hashFromHex(config.app.networkId));
const contract = addressFromHex(config.app.counterAddress);
const gas = gasAmount(1_000_000n);
const wrap = (invocation: Invocation) =>
  defaultWalletAdapter.createRootInvocation(account.address, {
    invocation,
    gasLimit: gas,
  });
const normal = () =>
  createTransaction({
    invocation: wrap(
      Counter.v0_1.increment.invocation(contract, gas, { amount: 1n }),
    ),
    auth_claim: account.authClaim,
    uniquifier: { nonce: 1n, block_expiry_height: blockHeight(1_000n) },
    contracts_to_deploy: [],
  });
async function sign(tx = normal()) {
  return toHex0x(
    serializeSignedTransaction(
      await signTransaction(tx, account.signers, expectedNetwork),
    ),
  );
}

let server: Server;
async function listen(instance: Server) {
  server = instance;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
});

function rpcMock() {
  return vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      id: number;
      params: string[];
    };
    const result =
      body.method === "groundhog_networkInfo"
        ? { networkHash: config.app.networkId }
        : body.method === "groundhog_chainTip"
          ? { height: "10", blockHash: `0x${"00".repeat(32)}` }
          : body.method === "groundhog_sendRawTransaction"
            ? toHex0x(
                hashSignedTransaction(
                  deserializeSignedTransaction(fromHex0x(body.params[0]!)),
                ),
              )
            : body.method === "groundhog_requestAirdrop"
              ? {
                  attemptStatus: "succeeded",
                  recipient: config.app.signerAddress,
                  rawAmount: "100000000",
                  txHash: `0x${"44".repeat(32)}`,
                  height: "10",
                  status: { result: "ok" },
                }
              : null;
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
}
async function fixture(upstream = rpcMock()) {
  const handler = createApiHandler(config, upstream);
  const origin = await listen(
    createServer((req, res) => {
      void handler(req, res);
    }),
  );
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return {
    origin,
    upstream,
    post,
    send: (params: unknown) =>
      post("/groundhog-rpc", {
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_sendRawTransaction",
        params,
      }),
  };
}

describe("counter signing boundary", () => {
  it("tops up only the configured signer through the SDK RPC method", async () => {
    const { post, upstream } = await fixture();
    const response = await post("/api/topup", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hash: `0x${"44".repeat(32)}`,
      rawAmount: "100000000",
    });
    const calls = upstream.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .filter((body) => body.method === "groundhog_requestAirdrop");
    expect(calls).toHaveLength(1);
    expect(calls[0].params[0].recipient).toBe(config.app.signerAddress);
  });

  it("rejects caller-selected recipients and amounts before requesting an airdrop", async () => {
    const { post, upstream } = await fixture();
    for (const body of [
      null,
      [],
      { recipient: `0x${"33".repeat(32)}` },
      { amount: "1000" },
      { direction: "increment" },
    ]) {
      expect((await post("/api/topup", body)).status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("throttles concurrent and sequential top-ups across callers without extending the cooldown", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { post, upstream } = await fixture();
    const responses = await Promise.all([
      post("/api/topup", {}, { "x-forwarded-for": "192.0.2.1" }),
      post("/api/topup", {}, { "x-forwarded-for": "192.0.2.2" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 429,
    ]);
    const throttled = responses.find((response) => response.status === 429)!;
    expect(throttled.headers.get("retry-after")).toBe("600");
    expect((await throttled.json()).retryAfterSeconds).toBe(600);
    const calls = upstream.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .filter((body) => body.method === "groundhog_requestAirdrop");
    expect(calls).toHaveLength(1);
    const beforeRetry = upstream.mock.calls.length;
    clock.mockReturnValue(1_300_000);
    const early = await post(
      "/api/topup",
      {},
      { "x-forwarded-for": "192.0.2.3" },
    );
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe("300");
    expect(upstream).toHaveBeenCalledTimes(beforeRetry);
    clock.mockReturnValue(1_600_000);
    expect((await post("/api/topup", {})).status).toBe(200);
  });

  it("rejects cross-origin browser top-ups without using the allowed attempt", async () => {
    const { origin, post, upstream } = await fixture();
    for (const headers of [
      { origin: "https://attacker.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ])
      expect((await post("/api/topup", {}, headers)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      (
        await post(
          "/api/topup",
          {},
          { origin, "sec-fetch-site": "same-origin" },
        )
      ).status,
    ).toBe(200);
  });

  it("reports faucet rejection and allows a later top-up attempt", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const rpc = rpcMock();
    let rejected = true;
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const body = JSON.parse(String(init?.body));
        if (rejected && body.method === "groundhog_requestAirdrop") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "Faucet request rejected" },
          });
        }
        return rpc(input, init);
      });
    const { post } = await fixture(upstream);
    const failed = await post("/api/topup", {});
    expect(failed.status).toBe(503);
    expect((await failed.json()).error).toContain("cooldown");
    rejected = false;
    const requestsBeforeRetry = upstream.mock.calls.length;
    expect((await post("/api/topup", {})).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(requestsBeforeRetry);
    clock.mockReturnValue(1_600_000);
    expect((await post("/api/topup", {})).status).toBe(200);
  });

  it("does not report a reverted airdrop as a successful top-up", async () => {
    const rpc = rpcMock();
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "groundhog_requestAirdrop") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              attemptStatus: "succeeded",
              recipient: config.app.signerAddress,
              rawAmount: "100000000",
              txHash: `0x${"44".repeat(32)}`,
              height: "10",
              status: { result: "reverted" },
            },
          });
        }
        return rpc(input, init);
      });
    const { post } = await fixture(upstream);
    const response = await post("/api/topup", {});
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain(
      "did not execute successfully",
    );
  });

  it("publishes only public identity and requires the server-only signing key", async () => {
    const origin = await listen(createCounterServer(config));
    const response = await fetch(`${origin}/api/config`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain(key);
    expect(JSON.parse(body)).toEqual({
      networkId: config.app.networkId,
      counterAddress: config.app.counterAddress,
      signerAddress: toHex0x(account.address),
      explorerUrl: null,
    });
    expect(() =>
      loadServerConfig({
        ...environment,
        COUNTER_SIGNING_PRIVATE_KEY: undefined,
      }),
    ).toThrow("Server signing key");
  });

  it.each(["increment", "decrement"] as const)(
    "signs only one %s by one and does not submit during preparation",
    async (direction) => {
      const { post, upstream, send } = await fixture();
      const response = await post("/api/prepare", { direction });
      expect(response.status).toBe(200);
      const { transaction } = (await response.json()) as {
        transaction: string;
      };
      const signed = deserializeSignedTransaction(fromHex0x(transaction));
      expect(signed.signatures).toHaveLength(1);
      expect(signed.tx.invocation.invoked_address).toEqual(account.address);
      expect(signed.tx.invocation.entrypoint).toEqual(
        DefaultWallet.v0_1.execute.entrypoint,
      );
      expect(signed.tx.contracts_to_deploy).toEqual([]);
      const { calls } = decodeCalldata(
        DefaultWalletSpec,
        "DefaultWallet",
        "execute",
        signed.tx.invocation.calldata,
        buildNamedCodecs(DefaultWalletSpec.type_defs),
      ) as { calls: default_wallet.v0_1.$interface.WalletCall[] };
      expect(calls).toHaveLength(1);
      expect(calls[0]!.target).toEqual(contract);
      expect(calls[0]!.entrypoint).toEqual(Counter.v0_1[direction].entrypoint);
      expect(
        decodeCalldata(
          spec,
          "Counter",
          direction,
          calls[0]!.calldata,
          buildNamedCodecs(spec.type_defs),
        ),
      ).toEqual({ amount: 1n });
      expect(
        upstream.mock.calls.some(([, init]) =>
          String(init?.body).includes("groundhog_sendRawTransaction"),
        ),
      ).toBe(false);
      expect((await send([transaction])).status).toBe(200);
    },
  );

  it("rejects caller-selected targets, amounts, methods, and transaction data before signing", async () => {
    const { post, upstream } = await fixture();
    for (const body of [
      null,
      [],
      {},
      { direction: "initialize" },
      { direction: "transfer" },
      { direction: "increment", amount: 1 },
      { direction: "decrement", amount: "1000000" },
      { direction: "increment", target: "0x1234" },
      { direction: "increment", transaction: "0x1234" },
      { direction: "increment", nonce: 1 },
    ])
      expect((await post("/api/prepare", body)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses to sign or top up on an unexpected network", async () => {
    const upstream = rpcMock().mockImplementation(async (_input, init) =>
      Response.json({
        jsonrpc: "2.0",
        id: JSON.parse(String(init?.body)).id,
        result: { networkHash: `0x${"ff".repeat(32)}` },
      }),
    );
    const { post } = await fixture(upstream);
    const response = await post("/api/prepare", { direction: "increment" });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(key);
    expect((await post("/api/topup", {})).status).toBe(503);
    expect(
      upstream.mock.calls.every(
        ([, init]) =>
          JSON.parse(String(init?.body)).method === "groundhog_networkInfo",
      ),
    ).toBe(true);
  });

  it("rejects transfers, other contracts, all other entrypoints, and arbitrary amounts even when signed by the funded key", async () => {
    const { send, upstream } = await fixture();
    const calls = [
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
        receiver: contract,
        amount: 10n,
      }),
      Counter.v0_1.increment.invocation(
        addressFromHex(`0x${"33".repeat(32)}`),
        gas,
        { amount: 1n },
      ),
      Counter.v0_1.initialize.invocation(contract, gas, { initialValue: 1n }),
      Counter.v0_1.ping.invocation(contract, gas, { tag: 1n }),
      Counter.v0_1.error.invocation(contract, gas),
      Counter.v0_1.get.invocation(contract, gas),
      ...[0n, 2n, (1n << 64n) - 1n].flatMap((amount) => [
        Counter.v0_1.increment.invocation(contract, gas, { amount }),
        Counter.v0_1.decrement.invocation(contract, gas, { amount }),
      ]),
    ];
    for (const call of calls)
      expect(
        (await send([await sign({ ...normal(), invocation: wrap(call) })]))
          .status,
      ).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects changed wrappers, multiple calls, attached code, and malformed transactions", async () => {
    const { send, upstream } = await fixture();
    const valid = normal();
    const { calls } = decodeCalldata(
      DefaultWalletSpec,
      "DefaultWallet",
      "execute",
      valid.invocation.calldata,
      buildNamedCodecs(DefaultWalletSpec.type_defs),
    ) as { calls: default_wallet.v0_1.$interface.WalletCall[] };
    const variants = [
      {
        ...valid,
        invocation: { ...valid.invocation, gas_limit: gasAmount(2_000_000n) },
      },
      {
        ...valid,
        invocation: { ...valid.invocation, invoked_address: contract },
      },
      {
        ...valid,
        invocation: DefaultWallet.v0_1.execute.invocation(account.address, gas, {
          calls: [...calls, ...calls],
        }),
      },
      {
        ...valid,
        contracts_to_deploy: [
          {
            contract_type: ContractType.kRv32 as const,
            rv32_contract: { data: new Uint8Array([1]) },
          },
        ],
      },
    ];
    for (const tx of variants)
      expect((await send([await sign(tx)])).status).toBe(403);
    for (const params of [
      [],
      ["0x1234"],
      [await sign(), await sign()],
      ["0x" + "00".repeat(5_000)],
    ])
      expect((await send(params)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not replay an allowed submission after an upstream error", async () => {
    const upstream = rpcMock().mockRejectedValue(new Error("lost response"));
    const { send } = await fixture(upstream);
    expect((await send([await sign()])).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("keeps signed hashes independent so a burst can be submitted concurrently", async () => {
    const { post, send, upstream } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        post("/api/prepare", { direction: "increment" }),
      ),
    );
    const transactions = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        return ((await response.json()) as { transaction: string }).transaction;
      }),
    );
    const hashes = transactions.map((tx) =>
      toHex0x(
        hashSignedTransaction(deserializeSignedTransaction(fromHex0x(tx))),
      ),
    );
    expect(new Set(hashes).size).toBe(20);
    expect(
      upstream.mock.calls.filter(([, init]) =>
        String(init?.body).includes("groundhog_chainTip"),
      ),
    ).toHaveLength(1);
    expect(
      (await Promise.all(transactions.map((tx) => send([tx])))).every(
        (response) => response.status === 200,
      ),
    ).toBe(true);
  });

  it("rejects batches and non-app RPC methods and keeps environment files out of the static server", async () => {
    const origin = await listen(createCounterServer(config));
    for (const body of [
      "[]",
      "null",
      "{",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_requestAirdrop",
      }),
    ]) {
      expect(
        (await fetch(`${origin}/groundhog-rpc`, { method: "POST", body }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    }
    for (const path of [
      "/.env.local",
      "/%2e%2e/server/config.ts",
      "/server/main.ts",
      "/assets/../../package.json",
    ])
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
  });
});
