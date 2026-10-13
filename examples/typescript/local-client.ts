import { createThruputClient, localnet } from "@thruputchain/client";

// Shared endpoint configuration only; each example keeps its SDK calls visible.
export function createLocalClient() {
  const rpcUrl = new URL(
    process.env.THRUPUT_RPC_URL ?? "http://127.0.0.1:9545",
  );
  if (
    rpcUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(rpcUrl.hostname) ||
    rpcUrl.username ||
    rpcUrl.password ||
    rpcUrl.search ||
    rpcUrl.hash
  ) {
    throw new Error("These examples require a loopback HTTP THRUPUT_RPC_URL");
  }
  return createThruputClient({ cluster: localnet({ rpcUrl: rpcUrl.href }) });
}
