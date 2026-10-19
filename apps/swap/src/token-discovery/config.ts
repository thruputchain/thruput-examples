import { toBase58 } from "@thruputchain/client";
import { canonicalIdentifier, type DiscoveryScope } from "./wire.ts";

type Environment = Record<string, string | boolean | undefined>;

export interface DiscoveryConfig {
  enabled: boolean;
  factoryAddress: string;
  tokenCodeHash: string;
  scope: DiscoveryScope | null;
}

export function loadDiscoveryConfig(environment: Environment): DiscoveryConfig {
  const flag = environment.VITE_TOKEN_DISCOVERY_ENABLED;
  if (flag !== undefined && ![true, false, "true", "false"].includes(flag)) {
    throw new Error("VITE_TOKEN_DISCOVERY_ENABLED must be true or false");
  }
  const enabled = flag === true || flag === "true";
  const factoryAddress = optionalHash(
    "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
    true,
  );
  const tokenCodeHash = optionalHash("VITE_STANDARD_TOKEN_HASH", false);
  let scope: DiscoveryScope | null = null;
  if (enabled) {
    const network = environment.VITE_THRUPUT_NETWORK_ID;
    if (!canonicalIdentifier(network)) {
      throw new Error("VITE_THRUPUT_NETWORK_ID must be a base58 32-byte hash");
    }
    if (!factoryAddress || !tokenCodeHash) {
      throw new Error(
        "Enabled token discovery requires VITE_STANDARD_TOKEN_FACTORY_ADDRESS and VITE_STANDARD_TOKEN_HASH",
      );
    }
    scope = {
      networkId: network,
      factoryAddress,
      tokenCodeHash,
    };
  }
  return { enabled, factoryAddress, tokenCodeHash, scope };

  function optionalHash(key: string, address: boolean): string {
    const value = environment[key];
    if (value === undefined || value === "") return "";
    if (!canonicalIdentifier(value)) {
      throw new Error(
        `${key} must be a base58 32-byte ${address ? "contract address" : "hash"}`,
      );
    }
    if (address && value === toBase58(new Uint8Array(32)))
      throw new Error(`${key} must be nonzero`);
    return value;
  }
}
