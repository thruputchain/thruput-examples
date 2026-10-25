import { loadDiscoveryConfig } from "../src/token-discovery/config.ts";

export function loadTokenDiscoveryServerConfig(
  environment: Record<string, string | undefined>,
) {
  const config = loadDiscoveryConfig(environment);
  const value = environment.TOKEN_DISCOVERY_UPSTREAM_ORIGIN;
  let origin: string | null = null;
  if (value !== undefined && value !== "") {
    try {
      const url = new URL(value);
      const authority = /^https?:\/\/([^/?#\\]+)\/?$/i.exec(value);
      const host = authority?.[1]?.replace(/:\d+$/, "").toLowerCase();
      if (
        !authority ||
        /\s/.test(value) ||
        authority[1]!.includes("@") ||
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            (["localhost", "127.0.0.1", "[::1]"].includes(host ?? "") ||
              (environment.RAILWAY_ENVIRONMENT_ID !== undefined &&
                host === "token-launchpad.railway.internal"))
          ))
      )
        throw new Error();
      origin = url.origin;
    } catch {
      throw new Error(
        "TOKEN_DISCOVERY_UPSTREAM_ORIGIN must be an HTTPS root origin or exact loopback HTTP origin without credentials (Railway also permits token-launchpad.railway.internal)",
      );
    }
  }
  if (config.enabled && origin === null)
    throw new Error(
      "TOKEN_DISCOVERY_UPSTREAM_ORIGIN is required when token discovery is enabled",
    );
  return config.scope === null || origin === null
    ? null
    : { scope: config.scope, origin };
}
