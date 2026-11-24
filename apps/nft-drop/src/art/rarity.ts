/** A trait as the art and rarity code need it: names and relative weights. */
export interface TraitShape {
  name: string;
  values: { name: string; weight: bigint }[];
}

export type Tier = "common" | "uncommon" | "rare" | "legendary";

/** The chance that a token rolls `value` for `trait`, from 0 to 1. */
export function share(trait: TraitShape, value: number): number {
  const total = trait.values.reduce((sum, v) => sum + Number(v.weight), 0);
  return total === 0 ? 0 : Number(trait.values[value]?.weight ?? 0n) / total;
}

export function tier(chance: number): Tier {
  if (chance >= 0.25) return "common";
  if (chance >= 0.1) return "uncommon";
  if (chance >= 0.03) return "rare";
  return "legendary";
}

const order: Tier[] = ["common", "uncommon", "rare", "legendary"];

/** A token's tier is the rarest tier among its values. */
export function tokenTier(traits: TraitShape[], rolled: number[]): Tier {
  return rolled.reduce<Tier>((best, value, index) => {
    const current = tier(share(traits[index]!, value));
    return order.indexOf(current) > order.indexOf(best) ? current : best;
  }, "common");
}

/** How rare the whole combination is: "1 in N". */
export function oneIn(traits: TraitShape[], rolled: number[]): number {
  const chance = rolled.reduce(
    (product, value, index) => product * share(traits[index]!, value),
    1,
  );
  return chance === 0 ? Infinity : Math.round(1 / chance);
}

/** Roll values the way the contract does, but with `random` in place of a hash. */
export function roll(
  traits: TraitShape[],
  random: () => number = Math.random,
): number[] {
  return traits.map((trait) => {
    let pick =
      random() * trait.values.reduce((sum, v) => sum + Number(v.weight), 0);
    for (const [index, value] of trait.values.entries()) {
      if (pick < Number(value.weight)) return index;
      pick -= Number(value.weight);
    }
    return trait.values.length - 1;
  });
}

/** A small seeded generator, so a drop card always shows the same sample. */
export function seeded(bytes: Uint8Array): () => number {
  let state =
    bytes.reduce((h, b) => Math.imul(h ^ b, 16777619), 2166136261) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: picks an art variant from a trait and value name. */
export function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export const percent = (chance: number) =>
  `${(chance * 100).toFixed(chance < 0.1 ? 1 : 0)}%`;
