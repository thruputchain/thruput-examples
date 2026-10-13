import { toHex0x } from "@thruputchain/client";
import { createLocalClient } from "./local-client.ts";

const client = await createLocalClient();
const tip = await client.getChainTip();

console.log(
  JSON.stringify(
    {
      rpcUrl: client.cluster.rpcUrl,
      networkHash: toHex0x(client.network.networkHash),
      height: tip.height.toString(),
    },
    null,
    2,
  ),
);
