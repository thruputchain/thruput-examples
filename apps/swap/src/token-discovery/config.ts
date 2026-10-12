import type { DiscoveryScope } from "./wire.ts";

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
    if (
      typeof network !== "string" ||
      !/^(?:0x)?[0-9a-fA-F]{64}$/.test(network) ||
      network.trim() !== network
    ) {
      throw new Error(
        "VITE_THRUPUT_NETWORK_ID must be a 32-byte hexadecimal value",
      );
    }
    if (!factoryAddress || !tokenCodeHash) {
      throw new Error(
        "Enabled token discovery requires VITE_STANDARD_TOKEN_FACTORY_ADDRESS and VITE_STANDARD_TOKEN_HASH",
      );
    }
    scope = {
      networkId: network.replace(/^0x/, "").toLowerCase(),
      factoryAddress,
      tokenCodeHash,
    };
  }
  return { enabled, factoryAddress, tokenCodeHash, scope };

  function optionalHash(key: string, address: boolean): string {
    const value = environment[key];
    if (value === undefined || value === "") return "";
    const pattern = address
      ? /^0x[0-9a-fA-F]{64}$/
      : /^(?:0x)?[0-9a-fA-F]{64}$/;
    if (
      typeof value !== "string" ||
      !pattern.test(value) ||
      value.trim() !== value
    ) {
      throw new Error(
        `${key} must be a 32-byte hexadecimal ${address ? "0x-prefixed address" : "value"}`,
      );
    }
    const normalized = `0x${value.replace(/^0x/, "").toLowerCase()}`;
    if (address && normalized === `0x${"0".repeat(64)}`)
      throw new Error(`${key} must be nonzero`);
    return normalized;
  }
}
