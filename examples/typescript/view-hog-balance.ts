import { addressFromHex, formatUnits, toHex0x } from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { HOG_ADDRESS } from "@thruputchain/protocol";
import { createLocalClient } from "./local-client.ts";

const addressHex = process.env.THRUPUT_ADDRESS;
if (!addressHex)
  throw new Error("Set THRUPUT_ADDRESS to a public account address");
const address = addressFromHex(addressHex);
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
      account: toHex0x(address),
      rawBalance: balance.value.toString(),
      hog: formatUnits(balance.value, 7),
      height: balance.height.toString(),
    },
    null,
    2,
  ),
);
