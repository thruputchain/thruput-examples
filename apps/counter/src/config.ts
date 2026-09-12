export interface AppConfig {
  networkId: string;
  counterAddress: string;
  developmentPrivateKey: string;
  explorerUrl: string | null;
}

export function hex32(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${name} must contain 32 bytes in hex. Run setup:local.`);
  }
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

export function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error(
      "Use an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  return url;
}

export function parseConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object")
    throw new Error("Counter configuration is missing.");
  const config = value as Record<string, unknown>;
  let explorerUrl: string | null = null;
  if (config.explorerUrl) {
    if (typeof config.explorerUrl !== "string")
      throw new Error("Invalid explorer URL.");
    const url = parseHttpUrl(config.explorerUrl);
    if (url.pathname !== "/") throw new Error("Use the explorer's origin URL.");
    explorerUrl = url.origin;
  }
  return {
    networkId: hex32(config.networkId, "Network ID"),
    counterAddress: hex32(config.counterAddress, "Counter address"),
    developmentPrivateKey: hex32(
      config.developmentPrivateKey,
      "Development key",
    ),
    explorerUrl,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}
