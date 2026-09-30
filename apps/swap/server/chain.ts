import {
  addressFromHex,
  ContractDecodeError,
  ContractViewError,
  createGroundhogClient,
  defineCluster,
  hashFromHex,
  HttpTransport,
  JsonRpcError,
  GroundhogRpcErrorCode,
  toHex0x,
  type EventPage,
  type EventQuery,
  type GroundhogClient,
  type IdentifiedEvent,
  type Transport,
  type TransportRequestOptions,
} from "@groundhogchain/client";
import { networkHash } from "@groundhogchain/protocol";

import { SwapFactory, swap_if } from "../src/contracts/generated/swap-factory.ts";
import type { ServerConfig } from "./config.ts";
import type { RegistryPool, RegistryScope } from "../shared/registry.ts";

const PoolCreated = swap_if.v0_1.events.PoolCreated;
type PoolCreated = swap_if.v0_1.events.PoolCreated;

const MAX_CURSOR_CHARACTERS = 4_096;
const FACTORY_VERIFICATION_ATTEMPTS = 3;
const ZERO_ADDRESS = `0x${"0".repeat(64)}`;

export interface RegistrySourceRequest {
  anchorBlock: string;
  cursor: string | null;
  limit: number;
  signal: AbortSignal;
}

export interface RegistrySourcePage {
  pools: RegistryPool[];
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

export async function createGroundhogRegistrySource(
  config: Pick<ServerConfig, "rpcUrl" | "scope">,
): Promise<GroundhogRegistrySource> {
  const cluster = defineCluster({
    name: "swap-pool-registry",
    rpcUrl: config.rpcUrl.href,
    networkHash: networkHash(hashFromHex(`0x${config.scope.networkId}`)),
    capabilities: [] as const,
  });
  const transport = new SignalTransport(
    new HttpTransport(config.rpcUrl.href, { timeoutMs: 10_000 }),
  );
  const client = await createGroundhogClient({ cluster, transport });
  const source = new GroundhogRegistrySource(
    client,
    config.scope,
    (action, signal) => transport.withSignal(signal, action),
  );
  await source.verifyNetworkIdentity(new AbortController().signal);
  return source;
}

type RegistryClient = Pick<
  GroundhogClient,
  "getEvents" | "getNetworkInfo" | "view"
>;
type RpcRunner = <T>(
  action: () => Promise<T>,
  signal: AbortSignal,
) => Promise<T>;

export class GroundhogRegistrySource implements RegistrySource {
  readonly #client: RegistryClient;
  readonly #scope: RegistryScope;
  readonly #factoryAddress;
  readonly #runRpc: RpcRunner;

  constructor(
    client: RegistryClient,
    scope: RegistryScope,
    runRpc: RpcRunner = (action, signal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      return abortable(action(), signal);
    },
  ) {
    this.#client = client;
    this.#scope = scope;
    this.#factoryAddress = addressFromHex(scope.factoryAddress);
    this.#runRpc = runRpc;
  }

  async verifyNetworkIdentity(signal: AbortSignal): Promise<void> {
    const observed = await this.#runRpc(
      () => this.#client.getNetworkInfo(),
      signal,
    );
    if (toHex0x(observed.networkHash).slice(2) !== this.#scope.networkId) {
      throw new RegistryScopeVerificationError(
        "The RPC endpoint belongs to a different Groundhog network",
      );
    }
  }

  async getPage(request: RegistrySourceRequest): Promise<RegistrySourcePage> {
    await this.verifyNetworkIdentity(request.signal);

    let page: EventPage;
    try {
      page = await this.#runRpc(
        () =>
          this.#client.getEvents({
            filters: [
              PoolCreated.filter({ contractAddresses: [this.#factoryAddress] }),
            ],
            order: "ascending",
            anchor: { height: BigInt(request.anchorBlock) },
            ...(request.cursor === null
              ? {}
              : { cursor: decodeCursor(request.cursor) }),
            limit: request.limit,
          } satisfies EventQuery),
        request.signal,
      );
    } catch (error) {
      if (
        request.cursor !== null &&
        error instanceof JsonRpcError &&
        error.code === GroundhogRpcErrorCode.InvalidParams
      ) {
        // Groundhog has no cursor-specific code; every other continuation input is local and validated.
        throw new RegistryCursorRejectedError({ cause: error });
      }
      throw error;
    }

    if (page.events.length > request.limit) {
      throw new RegistryIntegrityError("RPC returned an oversized event page");
    }
    const metadata = validatePageMetadata(page, request.anchorBlock);
    const indexedAt = new Date().toISOString();
    const pools: RegistryPool[] = [];
    let previousPairCount: bigint | null = null;
    for (const event of page.events) {
      const pool = await this.#decodeAndVerifyEvent(
        event,
        indexedAt,
        request.signal,
      );
      const pairCount = BigInt(pool.pairCount);
      if (previousPairCount !== null && pairCount <= previousPairCount) {
        throw new RegistryIntegrityError(
          "PoolCreated evidence is duplicated or out of order",
        );
      }
      previousPairCount = pairCount;
      pools.push(pool);
    }

    // This is the last identity check before the caller can atomically commit the page.
    await this.verifyNetworkIdentity(request.signal);
    return {
      pools,
      nextCursor: encodeCursor(page.cursor),
      latestBlock: metadata.latestBlock,
      oldestBlock: metadata.oldestBlock,
    };
  }

  async #decodeAndVerifyEvent(
    event: IdentifiedEvent,
    indexedAt: string,
    signal: AbortSignal,
  ): Promise<RegistryPool> {
    let decoded;
    let eventSequence: string;
    try {
      eventSequence = sequenceDecimal(event.sequenceNumber);
      if (toHex0x(event.event.contractAddress) !== this.#scope.factoryAddress) {
        throw new Error("event emitter does not match the configured factory");
      }
      decoded = PoolCreated.decode(event.event);
      if (decoded === null)
        throw new Error("event does not decode as PoolCreated");
    } catch (error) {
      throw new RegistryIntegrityError(
        "Malformed canonical PoolCreated event",
        {
          cause: error,
        },
      );
    }

    const evidence = (() => {
      try {
        const token0Address = toHex0x(decoded.topics.token0);
        const token1Address = toHex0x(decoded.topics.token1);
        const liquidityTokenAddress = toHex0x(decoded.fields.liquidity_token);
        const handlerAddress = toHex0x(decoded.fields.handler);
        const driverAddress = toHex0x(decoded.fields.driver);
        const pairCount = unsignedDecimal(
          decoded.fields.pair_count,
          "pair count",
        );
        const createdBlock = unsignedDecimal(event.blockHeight, "event block");
        const transactionHash = toHex0x(event.txHash);
        if (
          token0Address === ZERO_ADDRESS ||
          token1Address === ZERO_ADDRESS ||
          liquidityTokenAddress === ZERO_ADDRESS ||
          handlerAddress === ZERO_ADDRESS ||
          driverAddress === ZERO_ADDRESS ||
          token0Address >= token1Address ||
          pairCount === "0" ||
          BigInt(pairCount) > 0xffff_ffffn
        ) {
          throw new Error("noncanonical pool evidence");
        }
        return {
          token0Address,
          token1Address,
          liquidityTokenAddress,
          handlerAddress,
          driverAddress,
          pairCount,
          createdBlock,
          transactionHash,
        };
      } catch (error) {
        throw new RegistryIntegrityError(
          "Malformed canonical PoolCreated event",
          { cause: error },
        );
      }
    })();

    for (
      let attempt = 0;
      attempt < FACTORY_VERIFICATION_ATTEMPTS;
      attempt += 1
    ) {
      let views;
      try {
        views = await this.#runRpc(
          () =>
            Promise.all([
              SwapFactory.v0_1.getPair.view({
                client: this.#client,
                contract: this.#factoryAddress,
                args: {
                  tokenA: decoded.topics.token0,
                  tokenB: decoded.topics.token1,
                },
              }),
              SwapFactory.v0_1.poolAddresses.view({
                client: this.#client,
                contract: this.#factoryAddress,
                args: {
                  tokenA: decoded.topics.token0,
                  tokenB: decoded.topics.token1,
                },
              }),
              SwapFactory.v0_1.pairAt.view({
                client: this.#client,
                contract: this.#factoryAddress,
                args: { index: decoded.fields.pair_count - 1n },
              }),
            ]),
          signal,
        );
      } catch (error) {
        if (
          error instanceof ContractDecodeError ||
          error instanceof ContractViewError
        ) {
          throw new RegistryIntegrityError(
            "Factory state verification failed deterministically",
            { cause: error },
          );
        }
        throw error;
      }
      const [pair, addresses, indexedPair] = views;
      if (
        pair.height !== addresses.height ||
        pair.height !== indexedPair.height ||
        pair.height < event.blockHeight
      ) {
        continue;
      }
      if (
        pair.value === null ||
        toHex0x(pair.value) !== evidence.handlerAddress ||
        toHex0x(addresses.value.liquidity_token) !==
          evidence.liquidityTokenAddress ||
        toHex0x(addresses.value.handler) !== evidence.handlerAddress ||
        toHex0x(addresses.value.driver) !== evidence.driverAddress ||
        indexedPair.value === null ||
        toHex0x(indexedPair.value[0]) !== evidence.token0Address ||
        toHex0x(indexedPair.value[1]) !== evidence.token1Address
      ) {
        throw new RegistryIntegrityError(
          "PoolCreated event contradicts live factory state",
        );
      }

      return {
        networkId: this.#scope.networkId,
        factoryAddress: this.#scope.factoryAddress,
        token0Address: evidence.token0Address,
        token1Address: evidence.token1Address,
        liquidityTokenAddress: evidence.liquidityTokenAddress,
        handlerAddress: evidence.handlerAddress,
        driverAddress: evidence.driverAddress,
        pairCount: evidence.pairCount,
        transactionHash: evidence.transactionHash,
        eventSequence,
        createdBlock: evidence.createdBlock,
        indexedAt,
      };
    }
    throw new RegistryIntegrityError(
      "Factory views could not be verified at one coherent block",
    );
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
    params?: unknown[],
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
    if (this.#signal !== null) {
      throw new RegistryIntegrityError("Concurrent registry RPC requests");
    }
    if (signal.aborted) return Promise.reject(signal.reason);
    this.#signal = signal;
    try {
      return action().finally(() => {
        this.#signal = null;
      });
    } catch (error) {
      this.#signal = null;
      throw error;
    }
  }
}

function encodeCursor(cursor: Uint8Array): string | null {
  if (cursor.length === 0) return null;
  const encoded = Buffer.from(cursor).toString("base64url");
  if (encoded.length > MAX_CURSOR_CHARACTERS) {
    throw new RegistryIntegrityError("RPC returned an oversized event cursor");
  }
  return encoded;
}

function decodeCursor(cursor: string): Uint8Array {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_CHARACTERS) {
    throw new RegistryIntegrityError("Invalid durable cursor");
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (
    bytes.length === 0 ||
    Buffer.from(bytes).toString("base64url") !== cursor
  ) {
    throw new RegistryIntegrityError("Invalid durable cursor");
  }
  return bytes;
}

function sequenceDecimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("event sequence must be a u32");
  }
  return String(value);
}

function unsignedDecimal(value: bigint, name: string): string {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${name} must be a nonnegative bigint`);
  }
  return value.toString();
}

function validatePageMetadata(
  page: EventPage,
  anchorBlock: string,
): { latestBlock: string; oldestBlock: string } {
  try {
    const anchor = BigInt(anchorBlock);
    const latestBlock = unsignedDecimal(page.latestBlock, "latest block");
    const oldestBlock = unsignedDecimal(page.oldestBlock, "oldest block");
    if (page.oldestBlock > page.latestBlock) {
      throw new Error("oldest block exceeds latest block");
    }

    let previousHeight: bigint | null = null;
    const identities = new Set<string>();
    for (const event of page.events) {
      unsignedDecimal(event.blockHeight, "event block");
      const sequence = sequenceDecimal(event.sequenceNumber);
      if (event.blockHeight < anchor || event.blockHeight > page.latestBlock) {
        throw new Error("event block is outside the requested page bounds");
      }
      if (event.blockHeight < page.oldestBlock) {
        throw new Error("event block predates the retained page bounds");
      }
      if (previousHeight !== null && event.blockHeight < previousHeight) {
        throw new Error("event blocks are out of order");
      }
      previousHeight = event.blockHeight;
      const identity = `${toHex0x(event.txHash)}:${sequence}`;
      if (identities.has(identity)) {
        throw new Error("duplicate event identity");
      }
      identities.add(identity);
    }
    return { latestBlock, oldestBlock };
  } catch (error) {
    throw new RegistryIntegrityError("Malformed registry event page metadata", {
      cause: error,
    });
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
