import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addressFromBase58,
  createThruputClient,
  HttpTransport,
  localnet,
  MockTransport,
  toBase58,
  toHex0x,
  type RpcParams,
  type TransportRequestOptions,
} from "@thruputchain/client";
import { CxsWriter } from "@thruputchain/xdr";
import { inspectRun, loadKeyFile, reconcileRun } from "@thruputchain/testkit";
import { parseConfig } from "../src/config";
import { setup } from "./index";

let directory: string;
let env: { VOTING_APP_ENV: string; VOTING_ARTIFACT: string };
let mock: MockTransport;
// Where each failure happens: funding at the faucet request, deployment in its
// receipt (an aborted execution), lostResponse after sendTransaction dispatches,
// verification in the poll-count view, and report when the report file
// becomes a directory during verification.
let fail:
  | "funding"
  | "deployment"
  | "lostResponse"
  | "verification"
  | "report"
  | undefined;
let sends: number;

async function readRun() {
  const parent = join(directory, ".local", "voting-setup");
  const names = (await readdir(parent)).sort();
  const runDirectory = join(parent, names.at(-1)!);
  return {
    runDirectory,
    report: await inspectRun(join(runDirectory, "transactions")),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "voting-setup-"));
  env = {
    VOTING_APP_ENV: join(directory, ".env.local"),
    VOTING_ARTIFACT: join(directory, "voting.rv32a"),
  };
  await writeFile(env.VOTING_ARTIFACT, "voting artifact");
  mock = new MockTransport();
  fail = undefined;
  sends = 0;
  vi.spyOn(HttpTransport.prototype, "request").mockImplementation(
    async <T>(
      method: string,
      params?: RpcParams,
      control?: TransportRequestOptions,
    ): Promise<T> => {
      if (method === "faucet_requestAirdrop" && fail === "funding")
        throw new Error("Funding stopped");
      const result = await mock.request<T>(method, params, control);
      if (method === "sendTransaction") {
        sends++;
        if (fail === "lostResponse")
          throw new Error("Response lost after submission");
      }
      // Every receipt returns the predicted Voting address, read from the
      // deployment step. Only the deployment decodes it; other receipts ignore it.
      if (method === "getTransactionReceipt" && result) {
        const { report } = await readRun();
        const address = report.steps.find(
          (step) => step.name === "deploy-voting",
        )?.metadata?.address;
        if (typeof address !== "string")
          throw new Error("Missing deployment intent");
        return {
          ...(result as object),
          execution:
            fail === "deployment"
              ? { result: "abort", abortData: "0x00" }
              : {
                  result: "return",
                  returnData: toHex0x(addressFromBase58(address)),
                },
        } as T;
      }
      if (method === "simulateInvocations") {
        if (fail === "report") {
          const { runDirectory } = await readRun();
          const path = join(runDirectory, "transactions", "report.json");
          await rm(path);
          await mkdir(path); // A completed-step report cannot replace a directory.
        }
        const writer = new CxsWriter();
        writer.writeUint64(fail === "verification" ? 1n : 0n);
        return {
          ...(result as object),
          results: [
            {
              output: {
                result: "return",
                returnData: toHex0x(writer.finish()),
              },
              events: [],
              gasUsed: "0",
            },
          ],
        } as T;
      }
      return result;
    },
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each([
  "http://192.168.1.5:9545",
  "https://rpc.example.test/?key=test",
  "https://rpc.example.test/#fragment",
  "https://user:password@rpc.example.test/",
])("rejects incompatible RPC URL %s before connecting", async (rpcUrl) => {
  await writeFile(env.VOTING_APP_ENV, "previous environment");
  await expect(setup({ ...env, THRUPUT_RPC_URL: rpcUrl })).rejects.toThrow(
    "Use HTTPS",
  );
  expect(HttpTransport.prototype.request).not.toHaveBeenCalled();
  expect(await readFile(env.VOTING_APP_ENV, "utf8")).toBe(
    "previous environment",
  );
});

it("publishes fresh verified deployments, keeps keys private, and returns a usable client", async () => {
  const first = await setup(env);
  const firstReport = (await readRun()).report;
  const second = await setup(env);
  expect(toBase58(second.address)).not.toBe(toBase58(first.address));
  await expect(second.client.getChainTip()).resolves.toMatchObject({
    blockHeight: 2n,
  });
  const environment = await readFile(env.VOTING_APP_ENV, "utf8");
  const config = parseConfig(parseEnv(environment));
  expect(toBase58(config.address)).toBe(toBase58(second.address));
  expect(config.networkId).toBe(toBase58(new Uint8Array(32)));
  expect((await stat(env.VOTING_APP_ENV)).mode & 0o777).toBe(0o600);
  const { runDirectory, report } = await readRun();
  expect(report.actors["Voting Deployer"]).not.toBe(
    firstReport.actors["Voting Deployer"],
  );
  expect(report.steps.map(({ name, state }) => ({ name, state }))).toEqual([
    { name: "fund-deployer", state: "completed" },
    { name: "deploy-voting", state: "completed" },
    { name: "verify-voting", state: "completed" },
  ]);
  expect(report.steps[1]?.metadata).toEqual({
    address: toBase58(second.address),
  });
  // Faucet funding and deployment are both recorded with their hashes.
  expect(
    report.attempts.map(({ actor, operation, step, outcome, state }) => ({
      actor,
      operation,
      step,
      outcome,
      state,
    })),
  ).toEqual(
    ["fund", "deploy"].map((operation, index) => ({
      actor: "Voting Deployer",
      operation,
      step: index === 0 ? "fund-deployer" : "deploy-voting",
      outcome: "succeeded",
      state: "committed",
    })),
  );
  expect(report.attempts.every((attempt) => attempt.transactionHash)).toBe(
    true,
  );
  expect(
    vi
      .mocked(HttpTransport.prototype.request)
      .mock.calls.filter(([method]) => method === "simulateInvocations")
      .at(-1)?.[1],
  ).toMatchObject({ minStateBlockHeight: "2" });
  const keyPath = join(runDirectory, "key.json");
  const key = JSON.parse(await readFile(keyPath, "utf8"));
  // The saved key restores the deployer recorded in the report.
  expect((await loadKeyFile(keyPath)).address).toBe(
    report.actors["Voting Deployer"],
  );
  expect(JSON.stringify(report)).not.toContain(key.seed);
  expect(environment).not.toContain(key.seed);
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
    key.seed,
  );
  expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  expect((await readdir(runDirectory)).sort()).toEqual([
    "key.json",
    "transactions",
  ]);
});

it.each(["funding", "deployment", "verification", "report"] as const)(
  "preserves the previous environment when %s fails",
  async (phase) => {
    fail = phase;
    await writeFile(env.VOTING_APP_ENV, "previous environment");
    // Each phase stops setup for its own reason.
    const reasons = {
      funding: { code: "fundingStopped" },
      deployment: { code: "transactionFailed" },
      verification: { message: expect.stringContaining("verification failed") },
      report: { code: "EISDIR" },
    };
    await expect(setup(env)).rejects.toMatchObject(reasons[phase]);
    expect(await readFile(env.VOTING_APP_ENV, "utf8")).toBe(
      "previous environment",
    );
    expect((await readdir(directory)).sort()).toEqual([
      ".env.local",
      ".local",
      "voting.rv32a",
    ]);
    if (phase !== "report") {
      const { report } = await readRun();
      expect(report.steps.at(-1)?.state).toBe("failed");
      expect(report.attempts).toHaveLength(phase === "funding" ? 1 : 2);
      if (phase === "funding")
        expect(report.attempts[0]).toMatchObject({
          operation: "fund",
          stopped: true,
          outcome: "unknown",
        });
      if (phase === "deployment")
        expect(report.attempts[1]?.outcome).toBe("failed");
      if (phase === "verification")
        expect(report.attempts[1]?.outcome).toBe("succeeded");
    }
  },
);

it("observes the original deployment after a lost response without resending", async () => {
  fail = "lostResponse";
  await setup(env);
  const { runDirectory, report } = await readRun();
  const deployment = report.attempts[1];
  expect(deployment?.outcome).toBe("succeeded");
  expect(deployment?.transactionHash).toBeTruthy();
  const client = await createThruputClient({
    cluster: localnet(),
    transport: mock,
  });
  const result = await reconcileRun(join(runDirectory, "transactions"), client);
  expect(result.observations[1]).toMatchObject({
    transactionHash: deployment?.transactionHash,
    outcome: "succeeded",
  });
  expect(sends).toBe(1);
  expect(await inspectRun(join(runDirectory, "transactions"))).toEqual(report);
});

it("keeps verified evidence when environment publication fails and removes the temporary file", async () => {
  await mkdir(env.VOTING_APP_ENV);
  await expect(setup(env)).rejects.toMatchObject({ code: "EISDIR" });
  const { report } = await readRun();
  expect(report.steps.at(-1)).toMatchObject({
    name: "verify-voting",
    state: "completed",
  });
  expect((await stat(env.VOTING_APP_ENV)).isDirectory()).toBe(true);
  expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
    "Voting ready",
  );
});

it.each([
  ["local", "http://127.0.0.1:9545/"],
  ["devnet", "https://rpc.thruput.network/"],
] as const)(
  "preserves %s discovery, RPC overrides, and explicit network checks",
  async (network, rpcUrl) => {
    await setup(env, network);
    expect(
      parseEnv(await readFile(env.VOTING_APP_ENV, "utf8")).THRUPUT_RPC_URL,
    ).toBe(rpcUrl);
    await setup(
      { ...env, THRUPUT_RPC_URL: "https://example.test/rpc" },
      network,
    );
    expect(
      parseEnv(await readFile(env.VOTING_APP_ENV, "utf8")).THRUPUT_RPC_URL,
    ).toBe("https://example.test/rpc");
    vi.mocked(HttpTransport.prototype.request).mockClear();
    await expect(
      setup(
        { ...env, THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(1)) },
        network,
      ),
    ).rejects.toMatchObject({
      code: "rpcIncompatible",
      context: { kind: "network" },
    });
    expect(
      vi
        .mocked(HttpTransport.prototype.request)
        .mock.calls.some(([method]) => method === "faucet_requestAirdrop"),
    ).toBe(false);
  },
);

it("accepts an optional manifest pin and rejects conflicting network inputs", async () => {
  const path = join(directory, "manifest.json");
  await writeFile(
    path,
    JSON.stringify({ networkHash: toBase58(new Uint8Array(32)) }),
  );
  await setup({ ...env, THRUPUT_RUNTIME_MANIFEST: path });
  vi.mocked(HttpTransport.prototype.request).mockClear();
  await expect(
    setup({
      ...env,
      THRUPUT_RUNTIME_MANIFEST: path,
      THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(1)),
    }),
  ).rejects.toThrow("disagree");
  expect(HttpTransport.prototype.request).not.toHaveBeenCalled();
});

it("rejects a network change between discovery and scenario connection before funding", async () => {
  const request = vi
    .mocked(HttpTransport.prototype.request)
    .getMockImplementation()!;
  let networkReads = 0;
  vi.mocked(HttpTransport.prototype.request).mockImplementation(
    async <T>(
      method: string,
      params?: RpcParams,
      control?: TransportRequestOptions,
    ): Promise<T> => {
      if (method === "getNetworkInfo" && ++networkReads > 1)
        return { networkHash: toBase58(new Uint8Array(32).fill(1)) } as T;
      return (await request(method, params, control)) as T;
    },
  );
  await writeFile(env.VOTING_APP_ENV, "previous environment");
  await expect(setup(env)).rejects.toMatchObject({
    code: "rpcIncompatible",
    context: { kind: "network" },
  });
  expect(await readFile(env.VOTING_APP_ENV, "utf8")).toBe(
    "previous environment",
  );
  expect(
    vi
      .mocked(HttpTransport.prototype.request)
      .mock.calls.some(([method]) => method === "faucet_requestAirdrop"),
  ).toBe(false);
  expect(sends).toBe(0);
});
