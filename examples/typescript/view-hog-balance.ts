import { parseAddress, formatUnits, toBase58 } from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { HOG_ADDRESS } from "@thruputchain/protocol";
import { createLocalClient } from "./local-client.ts";

const addressText = process.env.THRUPUT_ADDRESS;
if (!addressText)
  throw new Error("Set THRUPUT_ADDRESS to a public account address");
const address = parseAddress(addressText);
const client = await createLocalClient();

// A typed view reads committed state; it does not sign a transaction.
const balance = await ERC20.v0_1.getBalanceOf.view({
  client,
  contract: HOG_ADDRESS,
  caller: address,
  args: { addr: address },
});
console.log(
  JSON.stringify(
    {
      account: toBase58(address),
      rawBalance: balance.value.toString(),
      hog: formatUnits(balance.value, 7),
      height: balance.height.toString(),
    },
    null,
    2,
  ),
);
