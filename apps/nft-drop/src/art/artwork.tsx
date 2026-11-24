import type { ReactNode } from "react";
import { hashText, seeded, tokenTier, type TraitShape } from "./rarity";
import { DENSITY, PALETTES, STYLE_TRAITS, type StyleTrait } from "./style";

/**
 * Draws a token. The traits choose the palette, the composition, the number
 * of tiles, and an accent; the seed (the token ID) chooses each tile's shape,
 * turn, and color. So the same token always looks the same, and two tokens
 * with the same traits still differ.
 */
export function Artwork({
  traits,
  rolled,
  seed,
  size = 120,
  label,
}: {
  traits: TraitShape[];
  rolled: number[];
  /** A token ID, or any text, in place of one. */
  seed: string;
  size?: number;
  label?: string;
}) {
  const [paletteName, composition, density, accent] = STYLE_TRAITS.map(
    (style) => choose(traits, rolled, style),
  );
  const palette = PALETTES[paletteName!]!;
  const random = seeded(new TextEncoder().encode(seed));
  const pick = <T,>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)]!;
  const count = DENSITY[density!]!;
  const margin = 8;
  const cell = (100 - 2 * margin) / count;
  // The centered composition leaves the middle for one large shape.
  const middle =
    count % 2 === 0 ? [count / 2 - 1, count / 2] : [(count - 1) / 2];
  const tiles: ReactNode[] = [];

  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      const x = margin + column * cell;
      const y = margin + row * cell;
      let shape = pick(SHAPES);
      let turn = Math.floor(random() * 4);
      let ink = pick(palette.inks);
      const ground = random() < 0.35 ? pick(palette.inks) : null;
      if (
        composition === "Centered" &&
        middle.includes(row) &&
        middle.includes(column)
      )
        continue;
      if (composition === "Scattered" && random() < 0.45) continue;
      if (composition === "Diagonal") {
        // Bands of color run corner to corner, and the curves follow them.
        ink = palette.inks[(row + column) % palette.inks.length]!;
        shape = (row + column) % 2 ? "quarter" : "half";
        turn = (row + column) % 2 ? 0 : 1;
      }
      tiles.push(
        <g key={`${row}-${column}`}>
          {ground && ground !== ink ? (
            <rect x={x} y={y} width={cell} height={cell} fill={ground} />
          ) : null}
          <Tile shape={shape} x={x} y={y} size={cell} turn={turn} ink={ink} />
        </g>,
      );
    }
  }

  const named = traits.map(
    (t, i) => `${t.name}: ${t.values[rolled[i] ?? 0]?.name ?? ""}`,
  );
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={label ?? named.join(", ")}
      className="artwork"
      data-tier={tokenTier(traits, rolled)}
    >
      <rect width="100" height="100" fill={palette.background} />
      {tiles}
      {composition === "Centered" ? (
        <circle
          cx="50"
          cy="50"
          r={(middle.length * cell) / 2 - 1}
          fill={palette.inks[0]}
        />
      ) : null}
      {/* Accents sit over the tiles, cut out with the background color. */}
      {accent === "Ring" ? (
        <g fill="none">
          <circle
            cx="50"
            cy="50"
            r="36"
            stroke={palette.background}
            strokeWidth="7"
          />
          <circle
            cx="50"
            cy="50"
            r="36"
            stroke={palette.inks[1]}
            strokeWidth="3"
          />
        </g>
      ) : null}
      {accent === "Frame" ? (
        <rect
          x="3"
          y="3"
          width="94"
          height="94"
          fill="none"
          stroke={palette.inks[0]}
          strokeWidth="3"
        />
      ) : null}
      {accent === "Sun" ? (
        <g>
          <circle cx="50" cy="50" r="26" fill={palette.background} />
          <circle cx="50" cy="50" r="21" fill="#fdda24" />
          <circle
            cx="50"
            cy="50"
            r="21"
            fill="none"
            stroke="#141414"
            strokeWidth="1.5"
          />
        </g>
      ) : null}
    </svg>
  );
}

const SHAPES = [
  "circle",
  "quarter",
  "half",
  "triangle",
  "square",
  "bars",
] as const;

function Tile({
  shape,
  x,
  y,
  size,
  turn,
  ink,
}: {
  shape: (typeof SHAPES)[number];
  x: number;
  y: number;
  size: number;
  turn: number;
  ink: string;
}) {
  const pad = size * 0.08;
  const s = size - 2 * pad;
  const [left, top] = [x + pad, y + pad];
  const [cx, cy] = [x + size / 2, y + size / 2];
  const transform = `rotate(${turn * 90} ${cx} ${cy})`;
  switch (shape) {
    case "circle":
      return <circle cx={cx} cy={cy} r={s / 2} fill={ink} />;
    case "quarter":
      return (
        <path
          d={`M${left} ${top}h${s}A${s} ${s} 0 0 1 ${left} ${top + s}z`}
          fill={ink}
          transform={transform}
        />
      );
    case "half":
      return (
        <path
          d={`M${left} ${cy}A${s / 2} ${s / 2} 0 0 1 ${left + s} ${cy}z`}
          fill={ink}
          transform={transform}
        />
      );
    case "triangle":
      return (
        <path
          d={`M${left} ${top}L${left + s} ${top + s}H${left}z`}
          fill={ink}
          transform={transform}
        />
      );
    case "square":
      return (
        <rect
          x={cx - s * 0.3}
          y={cy - s * 0.3}
          width={s * 0.6}
          height={s * 0.6}
          fill={ink}
        />
      );
    default:
      return (
        <g fill={ink} transform={transform}>
          {[0, 1, 2].map((i) => (
            <rect
              key={i}
              x={left}
              y={top + (i * s) / 3 + s / 12}
              width={s}
              height={s / 6}
            />
          ))}
        </g>
      );
  }
}

/**
 * The style value a token shows for `style`: found by trait and value name.
 * A removed trait shows its first value. A value the style does not know,
 * from a drop made by another client, gets a value from its name's hash.
 */
function choose(
  traits: TraitShape[],
  rolled: number[],
  style: StyleTrait,
): string {
  const key = (text: string) => text.trim().toLowerCase();
  const index = traits.findIndex(
    (trait) => key(trait.name) === key(style.name),
  );
  if (index < 0) return defaultValue(style);
  const name = traits[index]!.values[rolled[index] ?? 0]?.name ?? "";
  const known = style.values.find((value) => key(value.name) === key(name));
  return (known ?? style.values[hashText(name) % style.values.length]!).name;
}

/** The value a removed trait shows: the most common one. */
function defaultValue(style: StyleTrait): string {
  return style.values.reduce((best, value) =>
    value.weight > best.weight ? value : best,
  ).name;
}
