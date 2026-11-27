import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import {
  fromHex0x,
  hashContract,
  isThruputError,
  toBase58,
} from "@thruputchain/client";
import { ContractType } from "@thruputchain/protocol";
import {
  inspectRun,
  reconcileRun,
  withLocalScenario,
} from "@thruputchain/testkit";
import { provisionSwap } from "./index";

test(
  "publishes verified local/devnet setup and recovers a lost transaction response",
  { timeout: 180_000 },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "swap-testkit-"));
    try {
      await withLocalScenario(
        { seed: "swap-setup", accounts: {} },
        async (node) => {
          const output = join(parent, ".env.local");
          const options = {
            network: "local" as const,
            rpcUrl: node.local.rpcUrl,
            output,
            publicDirectory: join(parent, "public"),
          };
          const first = await provisionSwap(options);
          // Both setup modes use the same flow. This tests devnet mode on an isolated local node.
          const current = await provisionSwap({
            ...options,
            network: "devnet",
            networkId: toBase58(node.client.network.networkHash),
          });
          assert.notEqual(toBase58(current.factory), toBase58(first.factory));
          const published = await readFile(output, "utf8");
          const environment = parseEnv(published);
          assert.equal(
            environment.VITE_SWAP_FACTORY_ADDRESS,
            toBase58(current.factory),
          );
          assert.equal(
            environment.VITE_SWAP_ROUTER_ADDRESS,
            toBase58(current.router),
          );
          assert.equal((await stat(output)).mode & 0o777, 0o600);
          // The LP token code asset is published under its hash.
          const asset = JSON.parse(
            await readFile(
              join(
                parent,
                "public",
                "contract-artifacts",
                `${environment.VITE_POOL_TOKEN_HASH}.json`,
              ),
              "utf8",
            ),
          );
          assert.equal(asset.hash, environment.VITE_POOL_TOKEN_HASH);
          // The published bytes hash to the published code hash.
          assert.equal(
            toBase58(
              hashContract({
                contract_type: ContractType.kRv32,
                rv32_contract: { data: fromHex0x(asset.data) },
              }),
            ),
            asset.hash,
          );

          const runs = join(parent, ".local", "swap-setup");
          const names = await readdir(runs);
          assert.equal(names.length, 2);
          for (const name of names) {
            const directory = join(runs, name);
            const report = await inspectRun(join(directory, "transactions"));
            assert.deepEqual(
              report.steps.map(({ name, state }) => `${name}:${state}`),
              [
                "fund-deployer:completed",
                "fund-native-reserve:completed",
                "register-handler:completed",
                "register-driver:completed",
                "deploy-factory:completed",
                "deploy-router:completed",
                "verify-swap:completed",
              ],
            );
            assert.deepEqual(
              report.attempts.map((attempt) => attempt.operation),
              ["fund", "call", "deploy", "deploy", "deploy", "deploy"],
            );
            for (const attempt of report.attempts) {
              assert.equal(attempt.outcome, "succeeded");
              assert.ok(attempt.transactionHash);
            }
            const key = JSON.parse(
              await readFile(join(directory, "key.json"), "utf8"),
            );
            assert.equal(report.actors["Swap Deployer"], key.address);
            assert.equal(
              (await stat(join(directory, "key.json"))).mode & 0o777,
              0o600,
            );
            assert.ok(!JSON.stringify(report).includes(key.seed));
            assert.ok(!published.includes(key.seed));
            // Signed transactions are private too.
            const evidence = join(directory, "transactions", "evidence");
            assert.equal((await stat(evidence)).mode & 0o777, 0o700);
            for (const file of await readdir(evidence))
              assert.equal(
                (await stat(join(evidence, file))).mode & 0o777,
                0o600,
              );
          }
          await assert.rejects(
            provisionSwap({
              ...options,
              networkId: toBase58(new Uint8Array(32).fill(9)),
            }),
            (error) =>
              isThruputError(error, "rpcIncompatible") &&
              error.context.kind === "network",
          );
          assert.equal(await readFile(output, "utf8"), published);
          assert.equal((await readdir(runs)).length, 2);

          // Drop the response to every signed transaction.
          let sends = 0;
          const proxy = createServer(async (request, response) => {
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of request)
                chunks.push(Buffer.from(chunk));
              const body = Buffer.concat(chunks).toString();
              const upstream = await fetch(node.local.rpcUrl, {
                method: "POST",
                body,
                headers: { "content-type": "application/json" },
              });
              const result = await upstream.text();
              if (JSON.parse(body).method === "sendTransaction") {
                sends++;
                response.destroy();
              } else {
                response.writeHead(upstream.status, {
                  "content-type": "application/json",
                });
                response.end(result);
              }
            } catch (error) {
              response.destroy(error instanceof Error ? error : undefined);
            }
          });
          await new Promise<void>((resolve) =>
            proxy.listen(0, "127.0.0.1", resolve),
          );
          try {
            const address = proxy.address();
            assert.ok(address && typeof address !== "string");
            // Setup observes each signed transaction instead of sending it again.
            await provisionSwap({
              ...options,
              rpcUrl: `http://127.0.0.1:${address.port}`,
            });
            assert.notEqual(await readFile(output, "utf8"), published);
            const run = (await readdir(runs)).find(
              (name) => !names.includes(name),
            )!;
            const directory = join(runs, run, "transactions");
            const report = await inspectRun(directory);
            assert.equal(report.steps.at(-1)?.state, "completed");
            // One send per signed transaction; the faucet request is not signed.
            const signed = report.attempts.filter(
              ({ operation }) => operation !== "fund",
            );
            assert.ok(signed.length > 0);
            assert.equal(sends, signed.length);
            assert.ok(
              report.attempts.every(({ outcome }) => outcome === "succeeded"),
            );
            const result = await reconcileRun(directory, node.client);
            assert.deepEqual(
              result.observations.map(({ transactionHash, outcome }) => [
                transactionHash,
                outcome,
              ]),
              report.attempts.map(({ transactionHash }) => [
                transactionHash,
                "succeeded",
              ]),
            );
            assert.equal(sends, signed.length);
            assert.deepEqual(await inspectRun(directory), report);
          } finally {
            proxy.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              proxy.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
