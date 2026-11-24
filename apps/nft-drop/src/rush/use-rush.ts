import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RushSnapshot } from "../../server/rush";

export type { RushSnapshot };

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

async function request(init?: RequestInit): Promise<RushSnapshot | null> {
  const response = await fetch(url("api/rush"), init);
  const body = (await response.json()) as {
    rush?: RushSnapshot | null;
    error?: string;
  };
  if (!response.ok)
    throw new Error(body.error ?? "The rush service is unavailable.");
  return body.rush ?? null;
}

export const isActive = (rush: RushSnapshot | null | undefined) =>
  rush ? rush.phase !== "done" && rush.phase !== "failed" : false;

/** The server's current or last rush, polled quickly while one runs. */
export function useRush() {
  const queries = useQueryClient();
  const rush = useQuery({
    queryKey: ["nft-drop", "rush"],
    queryFn: () => request(),
    refetchInterval: (query) => (isActive(query.state.data) ? 250 : 2_000),
  });
  const start = useMutation({
    mutationFn: (input: {
      drop: string;
      users: number;
      windowSeconds: number;
    }) =>
      request({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: (snapshot) =>
      queries.setQueryData(["nft-drop", "rush"], snapshot),
  });
  return { rush: rush.data ?? null, start };
}
