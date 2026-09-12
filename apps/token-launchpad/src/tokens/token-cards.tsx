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
import type { CreatedToken } from "@/contracts/launchpad-client";
import { formatUnits } from "@/launch/form";

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
        <Card key={token.addressHex}>
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
                !connected
                  ? "Connect a wallet"
                  : token.balanceLoading
                    ? "Loading..."
                    : token.balance === null
                      ? "Unavailable"
                      : amount(token.balance, token.decimals)
              }
            />
            <Detail
              label="Administrator"
              value={
                <BlockchainIdentifier
                  kind="address"
                  value={token.administratorHex}
                />
              }
            />
            <div className="flex items-center gap-2 rounded-lg bg-muted p-3 font-mono text-xs">
              <span className="min-w-0 flex-1">
                <BlockchainIdentifier kind="address" value={token.addressHex} />
              </span>
              <CopyIdentifierButton
                variant="ghost"
                label="Copy token address"
                value={token.addressHex}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
