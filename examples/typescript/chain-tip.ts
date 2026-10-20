import { toBase58 } from "@thruputchain/client";
import { createLocalClient } from "./local-client.ts";

const client = await createLocalClient();
const tip = await client.getChainTip();

console.log(
  JSON.stringify(
    {
      rpcUrl: client.cluster.rpcUrl,
      networkHash: toBase58(client.network.networkHash),
      height: tip.height.toString(),
    },
    null,
    2,
  ),
);
