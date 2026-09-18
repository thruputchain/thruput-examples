import {
  addressFromHex,
  toHex0x,
  type CoreGroundhogClient,
} from "@groundhogchain/client";
import { useEffect, useState } from "react";

import type { GlobalConfig } from "@/config";
import {
  createErc20ReadAdapter,
  type TokenMetadata,
} from "@/contracts/erc20-adapter";
import {
  createNetworkReadClient,
  NetworkMismatchError,
  verifyReadNetwork,
} from "@/groundhog/client";
import { tokenAddress } from "./creation-presets";

export async function readTokenPreview(
  config: GlobalConfig,
  address: string,
  signal: AbortSignal,
  suppliedClient?: Pick<CoreGroundhogClient, "view" | "getNetworkInfo">,
): Promise<TokenMetadata> {
  const client =
    suppliedClient ?? (await createNetworkReadClient(config, signal));
  await verifyReadNetwork(client, config);
  signal.throwIfAborted();
  const metadata = await createErc20ReadAdapter({
    client,
    contract: addressFromHex(address),
    caller: config.accountAddress,
  }).metadata();
  signal.throwIfAborted();
  return {
    name: metadata.name.value,
    symbol: metadata.symbol.value,
    decimals: metadata.decimals.value,
  };
}

type Preview =
  | { status: "pending" }
  | { status: "ready"; metadata: TokenMetadata }
  | { status: "unavailable"; networkMismatch: boolean };

export function useTokenPreview(
  config: GlobalConfig,
  value: string,
  client?: CoreGroundhogClient,
) {
  const address = tokenAddress(value);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([
    config.networkIdHex,
    config.rpcUrl.href,
    config.registryEnabled,
    toHex0x(config.accountAddress),
    address,
    attempt,
  ]);
  const [result, setResult] = useState<{
    key: string;
    preview: Preview;
  } | null>(null);
  useEffect(() => {
    setResult(null);
    if (address === null) return;
    const controller = new AbortController();
    let current = true;
    void readTokenPreview(config, address, controller.signal, client).then(
      (metadata) => {
        if (current) setResult({ key, preview: { status: "ready", metadata } });
      },
      (error: unknown) => {
        if (current)
          setResult({
            key,
            preview: {
              status: "unavailable",
              networkMismatch: error instanceof NetworkMismatchError,
            },
          });
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
    // The key includes every configuration value used by this read, not object identity.
  }, [key, client]);
  return {
    preview:
      address === null
        ? null
        : result?.key === key
          ? result.preview
          : ({ status: "pending" } as const),
    retry: () => setAttempt((current) => current + 1),
  };
}
