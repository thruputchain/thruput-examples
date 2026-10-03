import { addressFromHex } from "@groundhogchain/client";
import { contractViewQueryOptions, useClient } from "@groundhogchain/react";
import { useQuery } from "@tanstack/react-query";
import { Counter } from "../contracts/generated/counter";

export function useCounterValue(address: string) {
  const client = useClient();
  return useQuery({
    ...contractViewQueryOptions({ client, method: Counter.v0_1.get, contract: addressFromHex(address) }),
    refetchInterval: 2_000,
  });
}
