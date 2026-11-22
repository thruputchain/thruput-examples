/**
 * The drops' art style: a Bauhaus-style grid of geometric tiles.
 *
 * Each trait is a real visual choice. A creator can change the weights and
 * remove traits or values, but cannot add them: a new value would have
 * nothing to draw. The art finds traits and values by name.
 */
export interface StyleValue {
  name: string;
  weight: bigint;
}

export interface StyleTrait {
  name: string;
  /** What the trait changes in the image. */
  description: string;
  values: StyleValue[];
}

const value = (name: string, weight: bigint): StyleValue => ({ name, weight });

export const STYLE_TRAITS: StyleTrait[] = [
  {
    name: "Palette",
    description: "The colors.",
    values: [
      value("Bauhaus", 30n),
      value("Riso", 24n),
      value("Thruput", 20n),
      value("Forest", 14n),
      value("Dusk", 10n),
      value("Gold", 2n),
    ],
  },
  {
    name: "Composition",
    description: "How the tiles are arranged.",
    values: [
      value("Grid", 42n),
      value("Diagonal", 30n),
      value("Centered", 20n),
      value("Scattered", 8n),
    ],
  },
  {
    name: "Density",
    description: "How many tiles there are.",
    values: [value("Sparse", 30n), value("Balanced", 50n), value("Dense", 20n)],
  },
  {
    name: "Accent",
    description: "A finishing touch over the tiles.",
    values: [
      value("None", 60n),
      value("Ring", 25n),
      value("Frame", 13n),
      value("Sun", 2n),
    ],
  },
];

export interface Palette {
  background: string;
  inks: string[];
}

export const PALETTES: Record<string, Palette> = {
  Bauhaus: {
    background: "#f1e9d6",
    inks: ["#d1342c", "#1f4e9c", "#f2b705", "#141414"],
  },
  Riso: {
    background: "#f7efe5",
    inks: ["#ff5fa2", "#2c6cf6", "#ffb23e", "#1a1a1a"],
  },
  Thruput: { background: "#0a0a0a", inks: ["#fdda24", "#f5f5f0", "#6b6b6b"] },
  Forest: {
    background: "#e8ede0",
    inks: ["#2f5d3a", "#7fa36b", "#d9a441", "#1d2b22"],
  },
  Dusk: {
    background: "#1d1b33",
    inks: ["#ff7a59", "#ffc75f", "#845ec2", "#f9f871"],
  },
  Gold: { background: "#121212", inks: ["#e2b13c", "#f6dc8d", "#a37b23"] },
};

/** How many tiles across, by Density. */
export const DENSITY: Record<string, number> = {
  Sparse: 3,
  Balanced: 4,
  Dense: 6,
};
