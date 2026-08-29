import type { AppConfig } from "@/config";
import {
  assertSnapshotAgreement,
  parseLatest,
  parseManifest,
  parseProvenance,
  parseStatus,
  type LatestPointer,
  type LifeManifest,
  type LifeProvenance,
  type LifeStatus,
} from "./schema";

export interface ImmutableSnapshot {
  readonly latest: LatestPointer;
  readonly manifest: LifeManifest;
  readonly provenance: LifeProvenance;
  readonly manifestUrl: URL;
}

export class IndexerClient {
  private readonly requestBase: URL;
  private readonly proxyRequests: boolean;

  constructor(
    private readonly config: Pick<
      AppConfig,
      "indexerUrl" | "indexerProxyPath" | "networkId" | "contractAddress"
    >,
    private readonly fetcher: typeof fetch = (...args) =>
      globalThis.fetch(...args),
    requestBase?: URL,
  ) {
    this.proxyRequests =
      requestBase === undefined && typeof window !== "undefined";
    this.requestBase =
      requestBase ??
      (typeof window === "undefined"
        ? config.indexerUrl
        : new URL(config.indexerProxyPath, window.location.origin));
  }

  async snapshot(signal?: AbortSignal): Promise<ImmutableSnapshot> {
    const base = this.worldBase();
    const latest = parseLatest(
      await this.json(new URL("latest.json", base), signal),
      this.config.networkId,
      this.config.contractAddress,
    );
    const manifestUrl = this.confined(latest.manifestUrl);
    const provenanceUrl = new URL("provenance.json", manifestUrl);
    const [manifest, provenance] = await Promise.all([
      this.json(manifestUrl, signal).then(parseManifest),
      this.json(provenanceUrl, signal).then(parseProvenance),
    ]);
    assertSnapshotAgreement(latest, manifest, provenance);
    if (
      manifest.networkId !== this.config.networkId ||
      manifest.contractAddress !== this.config.contractAddress
    )
      throw new Error("snapshot is outside the configured world scope");
    return Object.freeze({ latest, manifest, provenance, manifestUrl });
  }

  async status(signal?: AbortSignal): Promise<LifeStatus> {
    return parseStatus(
      await this.json(new URL("status.json", this.worldBase()), signal),
    );
  }

  tileUrl(snapshot: ImmutableSnapshot, z: number, x: number, y: number): URL {
    if (
      ![z, x, y].every(Number.isSafeInteger) ||
      z < 0 ||
      z > 6 ||
      x < 0 ||
      y < 0 ||
      x >= Math.ceil(10_000 / (256 * 2 ** (6 - z))) ||
      y >= Math.ceil(10_000 / (256 * 2 ** (6 - z)))
    )
      throw new RangeError("invalid tile coordinate");
    return new URL(`tiles/${z}/${x}/${y}.bin`, snapshot.manifestUrl);
  }

  private worldBase(): URL {
    return this.requestUrl(
      `/v1/worlds/${this.config.networkId}/${this.config.contractAddress}/`,
    );
  }

  private confined(path: string): URL {
    const result = new URL(path, this.config.indexerUrl);
    if (
      result.origin !== this.config.indexerUrl.origin ||
      result.pathname !== path ||
      result.search ||
      result.hash
    ) {
      throw new Error("indexer URL escaped its configured origin");
    }
    return this.requestUrl(result.pathname);
  }

  private requestUrl(pathname: string): URL {
    return this.proxyRequests
      ? new URL(pathname.slice(1), this.requestBase)
      : new URL(pathname, this.requestBase);
  }

  private async json(url: URL, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok)
      throw new Error(`Indexer request failed (${response.status})`);
    const type = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/json")
      throw new Error(`Unexpected indexer content type: ${type ?? "missing"}`);
    return response.json() as Promise<unknown>;
  }
}
