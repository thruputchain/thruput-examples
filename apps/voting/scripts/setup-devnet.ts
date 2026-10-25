import { randomBytes } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import { deployVoting } from "./setup-local";

async function main() {
  const rpcUrl = new URL(
    process.env.THRUPUT_RPC_URL || "https://rpc.thruput.network",
  );
  if (
    rpcUrl.protocol !== "https:" ||
    rpcUrl.username ||
    rpcUrl.password ||
    rpcUrl.search ||
    rpcUrl.hash
  )
    throw new Error(
      "Devnet requires an HTTPS RPC URL without credentials, query, or fragment.",
    );
  const client = await createThruputClient({
    cluster: defineCluster({
      name: "devnet",
      rpcUrl: rpcUrl.href,
      capabilities: ["airdrop"],
      networkHash: networkHash(
        hashFromBase58(process.env.THRUPUT_NETWORK_ID ?? ""),
      ),
    }),
  });
  const version = await client.getVersionInfo();
  if (!/^14\./.test(version.wireFormat))
    throw new Error("RPC wire format 14.x is required.");
  const output = fileURLToPath(new URL("../.env.devnet", import.meta.url));
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
    const address = await deployVoting(client);
    await writeFile(
      temporary,
      [
        `THRUPUT_RPC_URL=${rpcUrl.href}`,
        `VITE_THRUPUT_NETWORK_ID=${toBase58(client.network.networkHash)}`,
        `VITE_VOTING_ADDRESS=${toBase58(address)}`,
        "PORT=3000",
        "",
      ].join("\n"),
    );
    await rename(temporary, output);
    console.log(`Voting ready: ${toBase58(address)}\nEnvironment: ${output}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
