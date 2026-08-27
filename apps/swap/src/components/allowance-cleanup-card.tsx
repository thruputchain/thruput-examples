import { addressFromHex, toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AppConfig } from "@/config";
import { loadCleanupAllowanceRequirement } from "@/transactions/account-allowance";
import {
  confirmAllowanceCleanupWasNotSigned,
  allowanceCleanupKey,
  loadAllowanceCleanup,
  runAllowanceCleanup,
} from "@/transactions/allowance-cleanup";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { formatTokenAmount } from "@/swap/model";
import type { PoolSnapshot, SnapshotReader } from "@/swap/snapshot";

interface AllowanceAsset {
  address: ContractAddress;
  addressHex: string;
  symbol: string;
  decimals: number;
  allowance: bigint;
  required: bigint;
}

export function AllowanceCleanupCard({
  config,
  snapshot,
  readSnapshot,
  writer,
  onRefresh,
}: {
  config: AppConfig;
  snapshot: PoolSnapshot | null;
  readSnapshot: SnapshotReader;
  writer: WriteBoundary;
  onRefresh: () => void;
}) {
  const [, setRevision] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const key = allowanceCleanupKey(config);
    const refresh = (event: StorageEvent) => {
      if (event.key === null || event.key === key) {
        setRevision((value) => value + 1);
      }
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [config]);
  let cleanup: ReturnType<typeof loadAllowanceCleanup> = null;
  let assets: AllowanceAsset[] = [];
  try {
    cleanup = loadAllowanceCleanup(config);
    assets = snapshot === null ? [] : allowanceAssets(config, snapshot);
  } catch {
    return (
      <Alert variant="destructive">
        <AlertTitle>Allowance cleanup unavailable</AlertTitle>
        <AlertDescription>
          Saved account transaction progress is invalid. Clear this site's local
          data before signing another transaction.
        </AlertDescription>
      </Alert>
    );
  }
  const excess = assets.filter((asset) => asset.allowance > asset.required);
  if (cleanup === null && excess.length === 0) return null;

  const run = async (token: ContractAddress, handler: ContractAddress) => {
    if (isRunning) return;
    setIsRunning(true);
    setMessage(null);
    try {
      const result = await runAllowanceCleanup(config, token, handler, {
        writeBoundary: writer,
        readAllowance: async (requestedToken, requestedHandler) => {
          if (toHex0x(requestedHandler) !== toHex0x(config.handlerAddress)) {
            throw new Error("The cleanup handler does not match this pool");
          }
          const fresh = await readSnapshot();
          return {
            value: allowanceFromSnapshot(config, fresh, requestedToken),
            height: fresh.chainHeight,
          };
        },
      });
      setMessage({
        notNeeded: "No unused allowance remains.",
        committed: "Unused allowance was removed.",
        pending: "The cleanup outcome is uncertain. Check the original transaction before continuing.",
        failed: result.kind === "failed" ? result.message : "",
      }[result.kind]);
      onRefresh();
      setRevision((value) => value + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Allowance cleanup failed");
    } finally {
      setIsRunning(false);
    }
  };

  const pendingAsset = cleanup === null
    ? null
    : assets.find(({ addressHex }) => addressHex === cleanup.tokenAddress) ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Unused allowances</h2></CardTitle>
        <CardDescription>
          Reduce handler permissions only to the amount still required by queued
          swaps and liquidity operations.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {cleanup === null ? (
          <ul className="grid gap-3">
            {excess.map((asset) => (
              <li className="flex flex-wrap items-center justify-between gap-3" key={asset.addressHex}>
                <div>
                  <p className="font-medium">{asset.symbol}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatTokenAmount(asset.allowance - asset.required, asset.decimals, 8)} unused
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isRunning}
                  onClick={() => run(asset.address, config.handlerAddress)}
                >
                  Reduce {asset.symbol} allowance
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {pendingAsset?.symbol ?? "Token"} allowance cleanup requires recovery.
            </p>
            {cleanup.transactionHash === null ? (
              <Button
                type="button"
                variant="outline"
                disabled={isRunning}
                onClick={() => void (async () => {
                  setIsRunning(true);
                  try {
                    await confirmAllowanceCleanupWasNotSigned(config);
                    setMessage("The unsigned cleanup marker was cleared.");
                    setRevision((value) => value + 1);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Cleanup recovery failed");
                  } finally {
                    setIsRunning(false);
                  }
                })()}
              >
                Confirm cleanup was not signed
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={isRunning}
                onClick={() => run(
                  addressFromHex(cleanup.tokenAddress),
                  addressFromHex(cleanup.handlerAddress),
                )}
              >
                Check cleanup status
              </Button>
            )}
          </div>
        )}
        {message === null ? null : (
          <p className="text-sm text-muted-foreground" role="status">{message}</p>
        )}
      </CardContent>
    </Card>
  );
}

function allowanceAssets(
  config: AppConfig,
  snapshot: PoolSnapshot,
): AllowanceAsset[] {
  const handlerAddress = toHex0x(config.handlerAddress);
  return [
    {
      address: snapshot.tokenA.address,
      addressHex: toHex0x(snapshot.tokenA.address),
      symbol: snapshot.tokenA.symbol,
      decimals: snapshot.tokenA.decimals,
      allowance: snapshot.tokenA.allowance,
    },
    {
      address: snapshot.tokenB.address,
      addressHex: toHex0x(snapshot.tokenB.address),
      symbol: snapshot.tokenB.symbol,
      decimals: snapshot.tokenB.decimals,
      allowance: snapshot.tokenB.allowance,
    },
    {
      address: config.liquidityTokenAddress,
      addressHex: toHex0x(config.liquidityTokenAddress),
      symbol: snapshot.liquidityTokenSymbol,
      decimals: snapshot.liquidityTokenDecimals,
      allowance: snapshot.liquidityAllowance,
    },
  ].map((asset) => ({
    ...asset,
    required: loadCleanupAllowanceRequirement(
      config,
      asset.addressHex,
      handlerAddress,
    ).requiredAllowance,
  }));
}

function allowanceFromSnapshot(
  config: AppConfig,
  snapshot: PoolSnapshot,
  token: ContractAddress,
): bigint {
  const tokenAddress = toHex0x(token);
  if (tokenAddress === toHex0x(snapshot.tokenA.address)) {
    return snapshot.tokenA.allowance;
  }
  if (tokenAddress === toHex0x(snapshot.tokenB.address)) {
    return snapshot.tokenB.allowance;
  }
  if (tokenAddress === toHex0x(config.liquidityTokenAddress)) {
    return snapshot.liquidityAllowance;
  }
  throw new Error("The cleanup token does not belong to this pool");
}
