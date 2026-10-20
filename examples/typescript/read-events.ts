import { parseAddress } from "@thruputchain/client";
import { counter } from "./generated/counter.ts";
import { createLocalClient } from "./local-client.ts";

const addressText = process.env.THRUPUT_COUNTER_ADDRESS;
if (!addressText)
  throw new Error(
    "Set THRUPUT_COUNTER_ADDRESS to the deployed Counter address",
  );
const address = parseAddress(addressText);
const client = await createLocalClient();
const PingEvent = counter.v0_1.implementation.PingEvent;
// Keep the upper block bound fixed while paging through this query.
const tip = await client.getChainTip();
const query = {
  filters: [PingEvent.filter({ contractAddresses: [address] })],
  anchor: { height: tip.height },
  order: "descending" as const,
  limit: 100,
};
let page = await client.getEvents(query);
const events = [...page.events];
while (page.cursor.length > 0) {
  page = await client.getEvents({ ...query, cursor: page.cursor });
  events.push(...page.events);
}

const tags = events.map(({ event }) => {
  const decoded = PingEvent.decode(event);
  if (!decoded)
    throw new Error("Event did not match the generated PingEvent schema");
  return decoded.topics.tag.toString();
});
console.log(
  JSON.stringify(
    { contractAddress: addressText, count: tags.length, tags },
    null,
    2,
  ),
);
