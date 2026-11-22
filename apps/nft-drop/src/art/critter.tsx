import { useId, type ReactNode } from "react";
import {
  hashText,
  share,
  tier,
  tokenTier,
  type Tier,
  type TraitShape,
} from "./rarity";

/**
 * Draws a token from its traits. Trait position picks the layer, and a hash of
 * the trait and value names picks the variant, so any trait names draw
 * consistently. The same traits always draw the same critter.
 *
 * Layers, by trait position: background, body, eyes, accessory, pattern, and
 * frame. A drop with fewer traits draws fewer layers, and a value named
 * "None" draws nothing.
 */

const COLORS: Record<string, [string, string]> = {
  sky: ["#bfe6ff", "#6cb8ef"],
  blue: ["#bfd8ff", "#5b8def"],
  mint: ["#c9f5e1", "#6fd3a6"],
  green: ["#d2f3b8", "#7fc24a"],
  teal: ["#cdf0ee", "#4fbcb6"],
  dusk: ["#3a3566", "#6a4f9a"],
  night: ["#1d2240", "#3a3f73"],
  purple: ["#e6d9ff", "#9c7af0"],
  pink: ["#ffd8e8", "#f08bb5"],
  red: ["#ffd0c8", "#ec6a55"],
  orange: ["#ffe0c2", "#f59a4a"],
  peach: ["#ffd9c4", "#f2a07f"],
  gold: ["#fff3b0", "#e2ac1c"],
  sun: ["#fff6c2", "#f5cf45"],
  silver: ["#f1f2f4", "#aab0ba"],
  white: ["#ffffff", "#d9dbe0"],
  black: ["#3a3a3a", "#111111"],
};
const PALETTE = Object.values(COLORS);
// Bright body colors for value names that are not color words.
const BODY_COLORS = [
  "#ff8a5b",
  "#5bc0eb",
  "#9bc53d",
  "#fde74c",
  "#c879ff",
  "#ff6f9c",
  "#3ddbb4",
  "#ffb347",
];

function colorWord(name: string): [string, string] | undefined {
  const word = name
    .toLowerCase()
    .split(/[^a-z]+/)
    .find((part) => part in COLORS);
  return word ? COLORS[word] : undefined;
}

function backgroundFor(name: string): [string, string] {
  return colorWord(name) ?? PALETTE[hashText(name) % PALETTE.length]!;
}

// A value named after a shape draws that shape; other names use a hash.
const SHAPES: Record<"body" | "eyes" | "accessory", string[][]> = {
  body: [
    ["round", "circle"],
    ["square", "box", "cube"],
    ["tall", "long"],
    ["blob", "jelly"],
    ["bean", "flat"],
    ["ghost", "spirit"],
  ],
  eyes: [
    ["dot"],
    ["wide", "big"],
    ["sleepy", "tired"],
    ["laser"],
    ["star"],
    ["heart", "love"],
  ],
  accessory: [
    ["cap", "hat"],
    ["scarf"],
    ["crown"],
    ["bow", "ribbon"],
    ["antenna"],
    ["halo"],
  ],
};

function shapeFor(
  layer: keyof typeof SHAPES,
  trait: string,
  value: string,
): number {
  const words = value.toLowerCase().split(/[^a-z]+/);
  const index = SHAPES[layer].findIndex((names) =>
    names.some((name) => words.includes(name)),
  );
  return index >= 0 ? index : hashText(`${trait}|${value}`);
}

/** A color word wins; otherwise the body and background pick a color together. */
function bodyColorFor(name: string, background: string): string {
  return (
    colorWord(name)?.[1] ??
    BODY_COLORS[hashText(`${name}|${background}`) % BODY_COLORS.length]!
  );
}

interface Body {
  top: number;
  cx: number;
  cy: number;
  shape: ReactNode;
}

function body(variant: number, fill: string): Body {
  const props = { fill, stroke: "rgba(0,0,0,0.35)", strokeWidth: 2.5 };
  switch (variant % 6) {
    case 0:
      return {
        top: 40,
        cx: 60,
        cy: 72,
        shape: <circle cx={60} cy={72} r={32} {...props} />,
      };
    case 1:
      return {
        top: 42,
        cx: 60,
        cy: 72,
        shape: <rect x={30} y={42} width={60} height={60} rx={16} {...props} />,
      };
    case 2:
      return {
        top: 30,
        cx: 60,
        cy: 66,
        shape: <rect x={37} y={30} width={46} height={74} rx={23} {...props} />,
      };
    case 3:
      return {
        top: 40,
        cx: 60,
        cy: 72,
        shape: (
          <path
            d="M60 40c22 0 34 14 32 34s-14 30-32 30-34-8-34-30 12-34 34-34z"
            {...props}
          />
        ),
      };
    case 4:
      return {
        top: 50,
        cx: 60,
        cy: 76,
        shape: <ellipse cx={60} cy={77} rx={36} ry={27} {...props} />,
      };
    default:
      return {
        top: 38,
        cx: 60,
        cy: 70,
        shape: (
          <path
            d="M28 104V68a32 32 0 0 1 64 0v36l-8-7-8 7-8-7-8 7-8-7-8 7-8-7z"
            strokeLinejoin="round"
            {...props}
          />
        ),
      };
  }
}

function eyes(variant: number, b: Body, legendary: boolean): ReactNode {
  const y = b.cy - 6;
  const [l, r] = [b.cx - 12, b.cx + 12];
  const ink = "#16161a";
  switch (variant % 6) {
    case 0:
      return [l, r].map((x) => (
        <circle key={x} cx={x} cy={y} r={4} fill={ink} />
      ));
    case 1:
      return [l, r].map((x) => (
        <g key={x}>
          <circle
            cx={x}
            cy={y}
            r={8}
            fill="#fff"
            stroke={ink}
            strokeWidth={1.5}
          />
          <circle cx={x + 2} cy={y + 1} r={4} fill={ink} />
        </g>
      ));
    case 2:
      return [l, r].map((x) => (
        <path
          key={x}
          d={`M${x - 6} ${y}q6 5 12 0`}
          stroke={ink}
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
        />
      ));
    case 3:
      return (
        <g>
          {legendary ? (
            <path
              d={`M${l} ${y}L0 ${y + 30}M${r} ${y}L120 ${y + 30}`}
              stroke="#ff3b3b"
              strokeWidth={3}
              opacity={0.75}
            />
          ) : null}
          {[l, r].map((x) => (
            <circle
              key={x}
              cx={x}
              cy={y}
              r={5}
              fill="#ff3b3b"
              stroke="#fff"
              strokeWidth={1.5}
            />
          ))}
        </g>
      );
    case 4:
      return [l, r].map((x) => (
        <path
          key={x}
          d={`M${x} ${y - 6}l2 4 4.5.6-3.3 3 .9 4.4L${x} ${y + 3.8}l-4.1 2.2.9-4.4-3.3-3 4.5-.6z`}
          fill={ink}
        />
      ));
    default:
      return [l, r].map((x) => (
        <path
          key={x}
          d={`M${x} ${y + 5}l-6-6a3.5 3.5 0 0 1 6-4 3.5 3.5 0 0 1 6 4z`}
          fill="#e5484d"
        />
      ));
  }
}

function accessory(variant: number, b: Body, legendary: boolean): ReactNode {
  const gold = legendary ? "#f5c518" : null;
  const top = b.top;
  switch (variant % 6) {
    case 0:
      return (
        <g fill={gold ?? "#2b6cb0"}>
          <path d={`M40 ${top + 6}a20 18 0 0 1 40 0z`} />
          <rect x={58} y={top + 2} width={30} height={6} rx={3} />
        </g>
      );
    case 1:
      return (
        <rect
          x={30}
          y={b.cy + 10}
          width={60}
          height={9}
          rx={4}
          fill={gold ?? "#e5484d"}
        />
      );
    case 2:
      return (
        <path
          d={`M42 ${top + 2}l5-16 8 10 5-14 5 14 8-10 5 16z`}
          fill={gold ?? "#f5c518"}
          stroke="#8a6a00"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      );
    case 3:
      return (
        <path
          d={`M60 ${top + 2}l-12-8v16zM60 ${top + 2}l12-8v16z`}
          fill={gold ?? "#d6457a"}
        />
      );
    case 4:
      return (
        <g stroke="#16161a" strokeWidth={2}>
          <path d={`M60 ${top}v-16`} />
          <circle cx={60} cy={top - 18} r={4} fill={gold ?? "#fdda24"} />
        </g>
      );
    default:
      return (
        <ellipse
          cx={60}
          cy={top - 8}
          rx={18}
          ry={5}
          fill="none"
          stroke={gold ?? "#fdda24"}
          strokeWidth={3}
        />
      );
  }
}

function pattern(variant: number, b: Body): ReactNode {
  const ink = "rgba(0,0,0,0.14)";
  switch (variant % 4) {
    case 0:
      return [-14, 4, 16].map((dx, i) => (
        <circle
          key={dx}
          cx={b.cx + dx}
          cy={b.cy + 12 + (i % 2) * 6}
          r={4}
          fill={ink}
        />
      ));
    case 1:
      return [0, 9, 18].map((dy) => (
        <path
          key={dy}
          d={`M${b.cx - 18} ${b.cy + 8 + dy}h36`}
          stroke={ink}
          strokeWidth={3}
          strokeLinecap="round"
        />
      ));
    case 2:
      return (
        <ellipse
          cx={b.cx}
          cy={b.cy + 16}
          rx={16}
          ry={12}
          fill="rgba(255,255,255,0.45)"
        />
      );
    default:
      return [-15, 15].map((dx) => (
        <circle
          key={dx}
          cx={b.cx + dx}
          cy={b.cy + 4}
          r={4}
          fill="rgba(255,105,140,0.45)"
        />
      ));
  }
}

export function Critter({
  traits,
  rolled,
  size = 120,
  label,
}: {
  traits: TraitShape[];
  rolled: number[];
  size?: number;
  label?: string;
}) {
  const id = useId().replace(/:/g, "");
  const layerTier = (index: number): Tier =>
    rolled[index] === undefined
      ? "common"
      : tier(share(traits[index]!, rolled[index]!));
  const valueName = (index: number) =>
    traits[index]?.values[rolled[index] ?? 0]?.name ?? "";
  const variant = (index: number) =>
    hashText(`${traits[index]?.name}|${valueName(index)}`);
  const shapeOf = (layer: keyof typeof SHAPES, index: number) =>
    shapeFor(layer, traits[index]?.name ?? "", valueName(index));
  const present = (index: number) =>
    index < traits.length && valueName(index).trim().toLowerCase() !== "none";

  const background = present(0) ? backgroundFor(valueName(0)) : COLORS.silver!;
  const goldBackground = layerTier(0) === "legendary";
  const bodyName = present(1) ? valueName(1) : "";
  const bodyRare = layerTier(1) === "rare" || layerTier(1) === "legendary";
  const fill = bodyRare
    ? `url(#${id}-shine)`
    : bodyColorFor(bodyName, present(0) ? valueName(0) : "");
  const shape = body(
    present(1) ? shapeOf("body", 1) : 0,
    present(1) ? fill : "#f4f1ea",
  );
  const overall = tokenTier(traits, rolled);

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="img"
      aria-label={
        label ?? traits.map((t, i) => `${t.name}: ${valueName(i)}`).join(", ")
      }
      className="critter"
      data-tier={overall}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop
            offset="0"
            stopColor={goldBackground ? "#fff3b0" : background[0]}
          />
          <stop
            offset="1"
            stopColor={goldBackground ? "#e2ac1c" : background[1]}
          />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a5f3fc" />
          <stop offset="0.5" stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#f9a8d4" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" fill={`url(#${id}-bg)`} />
      {goldBackground
        ? [
            [18, 20],
            [98, 26],
            [22, 96],
          ].map(([x, y]) => (
            <path
              key={`${x}`}
              d={`M${x} ${y! - 6}l1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4-4.4-1.6 4.4-1.6z`}
              fill="#fff"
            />
          ))
        : null}
      <ellipse cx="60" cy="108" rx="30" ry="5" fill="rgba(0,0,0,0.15)" />
      {shape.shape}
      {bodyRare ? (
        <path
          d={`M${shape.cx - 18} ${shape.top + 14}q8-8 18-6`}
          stroke="#fff"
          strokeWidth={3}
          fill="none"
          opacity={0.7}
          strokeLinecap="round"
        />
      ) : null}
      {present(4) ? pattern(variant(4), shape) : null}
      {present(2)
        ? eyes(shapeOf("eyes", 2), shape, layerTier(2) === "legendary")
        : eyes(0, shape, false)}
      <path
        d={`M${shape.cx - 5} ${shape.cy + 4}q5 4 10 0`}
        stroke="#16161a"
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
      {present(3)
        ? accessory(
            shapeOf("accessory", 3),
            shape,
            layerTier(3) === "legendary",
          )
        : null}
      {present(5) ? (
        <rect
          x="3"
          y="3"
          width="114"
          height="114"
          rx={variant(5) % 2 ? 14 : 4}
          fill="none"
          stroke={layerTier(5) === "legendary" ? "#f5c518" : "rgba(0,0,0,0.35)"}
          strokeWidth={4}
          strokeDasharray={variant(5) % 3 === 0 ? "8 5" : undefined}
        />
      ) : null}
    </svg>
  );
}
