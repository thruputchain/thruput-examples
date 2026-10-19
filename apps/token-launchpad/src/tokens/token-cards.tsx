import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { CopyIdentifierButton } from "@/components/copy-identifier-button";
import { Detail } from "@/components/detail";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { CreatedToken } from "@/registry/tokens";
import { formatUnits } from "@thruputchain/client";
import { useTokenBalance } from "@thruputchain/react";

export function TokenCards({
  tokens,
  connected,
}: {
  tokens: readonly CreatedToken[];
  connected: boolean;
}) {
  const amount = (value: bigint, decimals: number | null) =>
    decimals === null ? `${value} base units` : formatUnits(value, decimals);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {tokens.map((token) => (
        <Card key={token.address}>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{token.symbol}</CardTitle>
                <CardDescription>
                  {token.name} ·{" "}
                  {token.decimals === null
                    ? "Unsupported decimals"
                    : `${token.decimals} decimals`}
                </CardDescription>
              </div>
              <Badge variant="secondary">Block {token.block.toString()}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Detail
              label="Initial supply"
              value={amount(token.initialSupply, token.decimals)}
            />
            <Detail
              label={connected ? "Your balance" : "Wallet balance"}
              value={
                !connected ? "Connect a wallet" : <TokenBalance token={token} />
              }
            />
            <Detail
              label="Administrator"
              value={
                <BlockchainIdentifier
                  kind="address"
                  value={token.administrator}
                />
              }
            />
            <div className="flex items-center gap-2 rounded-lg bg-muted p-3 font-mono text-xs">
              <span className="min-w-0 flex-1">
                <BlockchainIdentifier kind="address" value={token.address} />
              </span>
              <CopyIdentifierButton
                variant="ghost"
                label="Copy token address"
                value={token.address}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TokenBalance({ token }: { token: CreatedToken }) {
  const balance = useTokenBalance({
    token: token.address,
    query: { staleTime: 10_000, refetchInterval: 15_000, retry: 1 },
  });
  return (
    <span role="status">
      {balance.data ? (
        <>
          {token.decimals === null
            ? `${balance.data.rawBalance} base units`
            : formatUnits(balance.data.rawBalance, token.decimals)}
          {balance.isError ? " (refresh unavailable)" : ""}
        </>
      ) : balance.isError ? (
        "Unavailable"
      ) : (
        "Loading..."
      )}
    </span>
  );
}
