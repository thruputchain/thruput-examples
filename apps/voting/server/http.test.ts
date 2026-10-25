// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVotingServer } from "./main";
import { loadConfig } from "./config";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("serves deep links and public config, rejects writes, and does not mask missing assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voting-http-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><h1>Voting</h1>",
  );
  const env = {
    THRUPUT_RPC_URL: "https://rpc.example.test",
    VITE_THRUPUT_NETWORK_ID: "11111111111111111111111111111111",
    VITE_VOTING_ADDRESS: "11111111111111111111111111111111",
    PRIVATE_VALUE: "must-not-leak",
  };
  const server = createVotingServer(loadConfig(env), directory);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  expect(
    (await fetch(`${origin}/polls/12`)).headers.get("content-type"),
  ).toContain("text/html");
  expect(await (await fetch(`${origin}/api/config`)).json()).toEqual({
    VITE_THRUPUT_NETWORK_ID: env.VITE_THRUPUT_NETWORK_ID,
    VITE_VOTING_ADDRESS: env.VITE_VOTING_ADDRESS,
  });
  expect((await fetch(`${origin}/assets/missing.js`)).status).toBe(404);
  expect((await fetch(`${origin}/api/unknown`)).status).toBe(404);
  expect((await fetch(`${origin}/healthz`)).status).toBe(200);
  expect(
    (
      await fetch(`${origin}/thruput-rpc`, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: {},
        }),
      })
    ).status,
  ).toBe(403);
});
