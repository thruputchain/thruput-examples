import {
  addressFromBase58,
  bytesEqual,
  createThruputClient,
  defineCluster,
  fixedBytes,
  hashFromBase58,
  HttpTransport,
  NativeRpcError,
  NativeRpcErrorCode,
  toBase58,
  type EventPage,
  type EventQuery,
  type ThruputClient,
  type IdentifiedEvent,
  type Transport,
  type TransportRequestOptions,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";

import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../src/contracts/generated/standard-token-factory.ts";
import type { RegistryScope, RegistryToken } from "../shared/registry.ts";
import type { ServerConfig } from "./config.ts";

const TokenCreated = standard_token_factory_if.v0_1.events.TokenCreated;
type TokenCreated = standard_token_factory_if.v0_1.events.TokenCreated;

export interface RegistrySourceRequest {
  anchorBlock: string;
  cursor: string | null;
  limit: number;
  signal: AbortSignal;
}

export interface RegistrySourcePage {
  tokens: RegistryToken[];
  nextCursor: string | null;
  latestBlock: string;
  oldestBlock: string;
}

export interface RegistrySource {
  verifyNetworkIdentity(signal: AbortSignal): Promise<void>;
  getPage(request: RegistrySourceRequest): Promise<RegistrySourcePage>;
}

export class RegistryIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryIntegrityError";
  }
}

export class RegistryScopeVerificationError extends RegistryIntegrityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryScopeVerificationError";
  }
}

export class RegistryCursorRejectedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The registry event cursor was rejected by the RPC", options);
    this.name = "RegistryCursorRejectedError";
  }
}

export async function createThruputRegistrySource(
  config: Pick<ServerConfig, "rpcUrl" | "scope">,
): Promise<ThruputRegistrySource> {
  const cluster = defineCluster({
    name: "token-registry",
    rpcUrl: config.rpcUrl.href,
    networkHash: networkHash(hashFromBase58(config.scope.networkId)),
    capabilities: [] as const,
  });
  const transport = new SignalTransport(
    new HttpTransport(config.rpcUrl.href, { timeoutMs: 10_000 }),
  );
  const client = await createThruputClient({
    cluster,
    transport,
  });
  const source = new ThruputRegistrySource(
    client,
    config.scope,
    (query, signal) =>
      transport.withSignal(signal, () => client.getEvents(query)),
    (signal) => transport.withSignal(signal, () => client.getNetworkInfo()),
  );
  await source.verifyNetworkIdentity(new AbortController().signal);
  await source.verifyScope();
  return source;
}

export class ThruputRegistrySource implements RegistrySource {
  readonly #client: Pick<
    ThruputClient,
    "getEvents" | "simulateInvocation" | "getNetworkInfo"
  >;
  readonly #getNetworkInfo: (
    signal: AbortSignal,
  ) => ReturnType<ThruputClient["getNetworkInfo"]>;
  readonly #getEvents: (
    query: EventQuery,
    signal: AbortSignal,
  ) => Promise<EventPage>;
  readonly #scope: RegistryScope;
  readonly #factoryAddress;
  readonly #expectedTokenHash;

  constructor(
    client: Pick<
      ThruputClient,
      "getEvents" | "simulateInvocation" | "getNetworkInfo"
    >,
    scope: RegistryScope,
    getEvents = (query: EventQuery, signal: AbortSignal) =>
      abortable(client.getEvents(query), signal),
    getNetworkInfo = (signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      return abortable(client.getNetworkInfo(), signal);
    },
  ) {
    this.#client = client;
    this.#getEvents = getEvents;
    this.#getNetworkInfo = getNetworkInfo;
    this.#scope = scope;
    this.#factoryAddress = addressFromBase58(scope.factoryAddress);
    this.#expectedTokenHash = fixedBytes(
      hashFromBase58(scope.tokenCodeHash),
      32,
    );
  }

  async verifyNetworkIdentity(signal: AbortSignal): Promise<void> {
    const observed = await this.#getNetworkInfo(signal);
    signal.throwIfAborted();
    if (toBase58(observed.networkHash) !== this.#scope.networkId) {
      throw new RegistryScopeVerificationError(
        "The RPC endpoint belongs to a different Thruput network",
      );
    }
  }

  async verifyScope(): Promise<void> {
    let observed;
    try {
      observed = (
        await StandardTokenFactory.v0_1.config.view({
          client: this.#client,
          address: this.#factoryAddress,
        })
      ).value;
    } catch (error) {
      throw new RegistryScopeVerificationError(
        "The configured token factory could not be read",
        { cause: error },
      );
    }
    if (!bytesEqual(observed.token_code_hash, this.#expectedTokenHash)) {
      throw new RegistryScopeVerificationError(
        "The configured token factory uses a different token implementation",
      );
    }
  }

  async getPage(request: RegistrySourceRequest): Promise<RegistrySourcePage> {
    await this.verifyNetworkIdentity(request.signal);
    let page: EventPage;
    try {
      page = await this.#getEvents(
        {
          filters: [
            TokenCreated.filter({
              addresses: [this.#factoryAddress],
            }),
          ],
          ...(request.cursor === null
            ? {
                start: {
                  order: "ascending" as const,
                  anchor: {
                    kind: "atHeight" as const,
                    blockHeight: BigInt(request.anchorBlock),
                  },
                },
              }
            : { cursor: decodeCursor(request.cursor) }),
          limit: request.limit,
        },
        request.signal,
      );
    } catch (error) {
      if (
        request.cursor !== null &&
        error instanceof NativeRpcError &&
        error.code === NativeRpcErrorCode.InvalidParams
      ) {
        throw new RegistryCursorRejectedError({ cause: error });
      }
      throw error;
    }

    const indexedAt = new Date().toISOString();
    const tokens = page.events.map((event) =>
      this.#decodeEvent(event, indexedAt),
    );
    await this.verifyNetworkIdentity(request.signal);
    return {
      tokens,
      nextCursor: encodeCursor(page.nextCursor),
      latestBlock: unsignedDecimal(
        page.latestIndexedBlockHeight,
        "latest block",
      ),
      oldestBlock: unsignedDecimal(
        page.oldestIndexedBlockHeight,
        "oldest block",
      ),
    };
  }

  #decodeEvent(event: IdentifiedEvent, indexedAt: string): RegistryToken {
    try {
      if (toBase58(event.event.address) !== this.#scope.factoryAddress) {
        throw new Error("event emitter does not match the configured factory");
      }
      const decoded = TokenCreated.decode(event.event);
      if (decoded === null)
        throw new Error("event does not decode as TokenCreated");
      const tokenCodeHash = toBase58(decoded.fields.token_code_hash);
      if (tokenCodeHash !== this.#scope.tokenCodeHash) {
        throw new Error("event token implementation hash does not match scope");
      }
      const decimals = decoded.fields.decimals;
      if (decimals !== null && decimals > 0xffff_ffffn) {
        throw new Error("event decimals are outside the u32 range");
      }
      return {
        networkId: this.#scope.networkId,
        factoryAddress: this.#scope.factoryAddress,
        tokenAddress: toBase58(decoded.topics.token),
        creatorAddress: toBase58(decoded.topics.creator),
        administratorAddress: toBase58(decoded.fields.administrator),
        initialHolderAddress: toBase58(decoded.fields.initial_holder),
        initialSupply: unsignedDecimal(
          decoded.fields.initial_supply,
          "initial supply",
        ),
        name: decoded.fields.name,
        symbol: decoded.fields.symbol,
        decimals: decimals === null ? null : Number(decimals),
        tokenCodeHash,
        transactionHash: toBase58(event.transactionHash),
        eventSequence: event.sequenceNumber,
        blockHeight: unsignedDecimal(event.blockHeight, "block height"),
        indexedAt,
      };
    } catch (error) {
      throw new RegistryIntegrityError(
        "Malformed canonical TokenCreated event",
        {
          cause: error,
        },
      );
    }
  }
}

class SignalTransport implements Transport {
  readonly #transport: Transport;
  #signal: AbortSignal | null = null;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  request<T>(
    method: string,
    params?: unknown[] | Record<string, unknown>,
    options?: TransportRequestOptions,
  ): Promise<T> {
    const signals = [options?.signal, this.#signal].filter(
      (signal): signal is AbortSignal =>
        signal !== undefined && signal !== null,
    );
    return this.#transport.request<T>(method, params, {
      ...(signals.length === 0
        ? {}
        : {
            signal:
              signals.length === 1 ? signals[0] : AbortSignal.any(signals),
          }),
    });
  }

  withSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#signal !== null) {
      throw new RegistryIntegrityError("Concurrent registry RPC requests");
    }
    this.#signal = signal;
    try {
      return action();
    } finally {
      this.#signal = null;
    }
  }
}

function encodeCursor(cursor: string | null): string | null {
  return cursor === null
    ? null
    : Buffer.from(cursor.slice(2), "hex").toString("base64url");
}

function decodeCursor(cursor: string): string {
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.length === 0)
    throw new RegistryIntegrityError("Invalid durable cursor");
  return `0x${bytes.toString("hex")}`;
}

function unsignedDecimal(value: bigint, name: string): string {
  if (value < 0n) throw new Error(`${name} must not be negative`);
  return value.toString();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
