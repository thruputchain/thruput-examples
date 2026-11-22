import {
  toBase58,
  type ContractAddress,
  type ContractViewOutcome,
  type ContractViewRequest,
  type CoreThruputClient,
  type TransactionReceipt,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import { ERC721, NftDrop, nft_drop } from "./generated/nft-drop";
import { NftDropFactory } from "./generated/nft-drop-factory";

export type DropDefinition = nft_drop.v0_1.implementation.DropDefinition;
export type DropConfig = nft_drop.v0_1.implementation.DropConfig;
export type Trait = nft_drop.v0_1.implementation.Trait;
export const TraitsRolled = nft_drop.v0_1.implementation.TraitsRolled;
export { ERC721, NftDrop, NftDropFactory };

/** The contract's limits. They are part of its ABI. */
export const LIMITS = {
  supply: 10_000,
  nameBytes: 100,
  symbolBytes: 10,
  traits: 6,
  values: 8,
  labelBytes: 24,
  weight: 10_000,
};

/**
 * Gas for the mint call. A mint uses about 296,000 with four traits, and
 * about 380,000 with the contract's maximum of six.
 */
export const MINT_GAS = gasAmount(400_000n);
/** Root gas for a wallet transaction that mints once. */
export const MINT_ROOT_GAS = gasAmount(1_000_000n);
/** Gas for creating a drop: the deployment and its initialization. */
export const CREATE_GAS = gasAmount(20_000_000n);

const value = (name: string, weight: bigint) => ({ name, weight });

/** The drop that setup creates, and the template for new drops. */
export const DEMO_DROP: DropDefinition = {
  name: "Thruput Critters",
  symbol: "CRIT",
  supply: 10_000n,
  traits: [
    {
      name: "Background",
      values: [
        value("Sky", 45n),
        value("Mint", 30n),
        value("Dusk", 20n),
        value("Gold", 5n),
      ],
    },
    {
      name: "Body",
      values: [
        value("Round", 40n),
        value("Square", 35n),
        value("Tall", 20n),
        value("Crystal", 5n),
      ],
    },
    {
      name: "Eyes",
      values: [
        value("Dot", 50n),
        value("Wide", 30n),
        value("Sleepy", 18n),
        value("Laser", 2n),
      ],
    },
    {
      name: "Accessory",
      values: [
        value("None", 55n),
        value("Cap", 25n),
        value("Scarf", 18n),
        value("Crown", 2n),
      ],
    },
  ],
};

/** The node accepts at most 16 views in one simulation batch. */
const VIEWS_PER_BATCH = 16;

function expectReturn<T>(outcome: ContractViewOutcome<T, unknown>): T {
  if (outcome.kind !== "return")
    throw new Error(
      "A drop could not be read. It may not exist on this network.",
    );
  return outcome.value;
}

/** Read views in batches of 16; every batch reads one committed snapshot. */
async function readAll<T>(
  client: CoreThruputClient,
  calls: ContractViewRequest<T, unknown>[],
): Promise<T[]> {
  const batches: ContractViewRequest<T, unknown>[][] = [];
  for (let i = 0; i < calls.length; i += VIEWS_PER_BATCH)
    batches.push(calls.slice(i, i + VIEWS_PER_BATCH));
  const results = await Promise.all(
    batches.map((batch) => client.readViews({ calls: batch })),
  );
  return results.flatMap((result) =>
    (result.results as ContractViewOutcome<T, unknown>[]).map(expectReturn),
  );
}

export interface DropSummary {
  address: ContractAddress;
  config: DropConfig;
  remaining: bigint;
}

/** Every drop address in the factory's list, oldest first. */
export async function dropAddresses(
  client: CoreThruputClient,
  factory: ContractAddress,
): Promise<ContractAddress[]> {
  const { value: count } = await NftDropFactory.v0_1.dropCount.view({
    client,
    address: factory,
  });
  return readAll(
    client,
    Array.from({ length: Number(count) }, (_, index) =>
      NftDropFactory.v0_1.dropAt.viewRequest({
        address: factory,
        args: { index: BigInt(index) },
      }),
    ),
  );
}

/** The newest drops first, with their configuration and remaining supply. */
export async function listDrops(
  client: CoreThruputClient,
  factory: ContractAddress,
): Promise<DropSummary[]> {
  const addresses = (await dropAddresses(client, factory)).reverse();
  const [configs, remaining] = await Promise.all([
    readAll(
      client,
      addresses.map((address) =>
        NftDrop.v0_1.getConfig.viewRequest({ address }),
      ),
    ),
    readAll(
      client,
      addresses.map((address) =>
        NftDrop.v0_1.remaining.viewRequest({ address }),
      ),
    ),
  ]);
  return addresses.map((address, i) => ({
    address,
    config: configs[i]!,
    remaining: remaining[i]!,
  }));
}

export interface DropDetails extends DropSummary {
  traits: Trait[];
  /** `counts[trait][value]`: how many tokens rolled each value. */
  counts: bigint[][];
}

export async function readDrop(
  client: CoreThruputClient,
  address: ContractAddress,
): Promise<DropDetails> {
  const [{ value: config }, { value: remaining }] = await Promise.all([
    NftDrop.v0_1.getConfig.view({ client, address }),
    NftDrop.v0_1.remaining.view({ client, address }),
  ]);
  const traits = await readAll(
    client,
    Array.from({ length: Number(config.trait_count) }, (_, index) =>
      NftDrop.v0_1.getTrait.viewRequest({
        address,
        args: { index: BigInt(index) },
      }),
    ),
  );
  const flat = await readAll(
    client,
    traits.flatMap((current, index) =>
      current.values.map((_, value) =>
        NftDrop.v0_1.traitCount.viewRequest({
          address,
          args: { index: BigInt(index), value: BigInt(value) },
        }),
      ),
    ),
  );
  let offset = 0;
  const counts = traits.map((current) => {
    const row = flat.slice(offset, offset + current.values.length);
    offset += current.values.length;
    return row;
  });
  return { address, config, remaining, traits, counts };
}

export interface Mint {
  tokenId: string;
  owner: string;
  traits: number[];
  blockHeight: bigint;
  transactionHash: string;
}

/** The newest mints, from `TraitsRolled` events. */
export async function recentMints(
  client: CoreThruputClient,
  address: ContractAddress,
  owner?: ContractAddress,
  limit = 48,
): Promise<Mint[]> {
  const page = await client.getContractEvents({
    event: TraitsRolled,
    addresses: [address],
    ...(owner ? { topics: { owner } } : {}),
    start: { order: "descending", anchor: { kind: "atEnd" } },
    limit,
  });
  return page.events.map((event) => ({
    tokenId: toBase58(event.fields.token_id),
    owner: toBase58(event.topics.owner),
    traits: Array.from(event.fields.traits),
    blockHeight: event.blockHeight,
    transactionHash: toBase58(event.transactionHash),
  }));
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The contract's validation, so the form can explain a problem first. */
export function validateDefinition(definition: DropDefinition): string | null {
  if (!definition.name.trim() || bytes(definition.name) > LIMITS.nameBytes)
    return `Enter a name of 1–${LIMITS.nameBytes} UTF-8 bytes.`;
  if (
    !definition.symbol.trim() ||
    bytes(definition.symbol) > LIMITS.symbolBytes
  )
    return `Enter a symbol of 1–${LIMITS.symbolBytes} UTF-8 bytes.`;
  if (definition.supply < 1n || definition.supply > BigInt(LIMITS.supply))
    return `Choose a supply of 1–${LIMITS.supply.toLocaleString()}.`;
  if (definition.traits.length < 1 || definition.traits.length > LIMITS.traits)
    return `Use 1–${LIMITS.traits} traits.`;
  const label = (text: string) =>
    text.trim() !== "" && bytes(text) <= LIMITS.labelBytes;
  const unique = (names: string[]) =>
    new Set(names.map((n) => n.trim())).size === names.length;
  if (!unique(definition.traits.map((t) => t.name)))
    return "Trait names must be different.";
  for (const current of definition.traits) {
    if (!label(current.name))
      return `Each trait needs a name of 1–${LIMITS.labelBytes} bytes.`;
    if (current.values.length < 2 || current.values.length > LIMITS.values)
      return `"${current.name}" needs 2–${LIMITS.values} values.`;
    if (!unique(current.values.map((v) => v.name)))
      return `Values of "${current.name}" must be different.`;
    for (const option of current.values) {
      if (!label(option.name))
        return `Each value needs a name of 1–${LIMITS.labelBytes} bytes.`;
      if (option.weight < 1n || option.weight > BigInt(LIMITS.weight))
        return `Weights must be 1–${LIMITS.weight.toLocaleString()}.`;
    }
  }
  return null;
}

const dropErrors: Record<string, string> = {
  1: "This drop is already initialized.",
  2: "The drop definition is not valid.",
  3: "Sold out: no tokens are left.",
};
const factoryErrors: Record<string, string> = {
  3: "The drop's funding was not enough.",
};

/** A plain-language reason for a committed transaction that failed. */
export function describeFailure(receipt: TransactionReceipt): string {
  const execution = receipt.execution;
  if ("result" in execution && execution.result === "abort") {
    for (const decode of [
      NftDrop.v0_1.mint.decodeException,
      NftDropFactory.v0_1.createDrop.decodeException,
    ]) {
      try {
        const exception = decode(execution.abortData);
        if (exception.kind === "declared") {
          const known =
            exception.name === "DropError"
              ? dropErrors[String(exception.value)]
              : exception.name === "FactoryError"
                ? factoryErrors[String(exception.value)]
                : undefined;
          if (known) return known;
        }
      } catch {
        // Not this method's exception; try the next.
      }
    }
  }
  return "The transaction committed, but the contract refused it. No changes were applied.";
}
