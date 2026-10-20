import { addressFromBase58 } from "@thruputchain/client";
import { contractViewQueryOptions, useClient } from "@thruputchain/react";
import { useQuery } from "@tanstack/react-query";
import { Counter } from "../contracts/generated/counter";

export function useCounterValue(address: string) {
  const client = useClient();
  return useQuery({
    ...contractViewQueryOptions({
      client,
      method: Counter.v0_1.get,
      contract: addressFromBase58(address),
    }),
    refetchInterval: 2_000,
  });
}
