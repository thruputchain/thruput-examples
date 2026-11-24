// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Artwork } from "./artwork";
import { oneIn, roll, seeded, share, tier, tokenTier } from "./rarity";
import { DEMO_DROP } from "../contracts/drops";

const traits = DEMO_DROP.traits;

describe("rarity", () => {
  it("turns weights into chances and tiers", () => {
    expect(share(traits[0]!, 0)).toBeCloseTo(0.3);
    expect(tier(share(traits[0]!, 0))).toBe("common");
    expect(tier(share(traits[0]!, 1))).toBe("uncommon");
    expect(tier(share(traits[1]!, 3))).toBe("rare");
    expect(tier(share(traits[0]!, 5))).toBe("legendary");
  });

  it("uses the rarest value as the token's tier, and multiplies chances", () => {
    expect(tokenTier(traits, [0, 0, 0, 0])).toBe("common");
    expect(tokenTier(traits, [0, 0, 0, 3])).toBe("legendary");
    // 0.30 × 0.42 × 0.30 × 0.60 ≈ 0.0227, so about 1 in 44.
    expect(oneIn(traits, [0, 0, 0, 0])).toBe(44);
  });

  it("rolls each value about as often as its weight", () => {
    const random = seeded(new Uint8Array([1, 2, 3]));
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 20_000; i++) counts[roll(traits, random)[0]!]!++;
    expect(counts[0]! / 20_000).toBeCloseTo(0.3, 1);
    expect(counts[5]! / 20_000).toBeCloseTo(0.02, 1);
  });

  it("repeats a seeded sequence", () => {
    const a = seeded(new Uint8Array([9]));
    const b = seeded(new Uint8Array([9]));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("artwork", () => {
  const markup = (rolled: number[], seed = "token", shape = traits) => {
    const { container, unmount } = render(
      <Artwork traits={shape} rolled={rolled} seed={seed} />,
    );
    const html = container.querySelector("svg")!.innerHTML;
    unmount();
    return html;
  };

  it("draws the same token the same way", () => {
    expect(markup([0, 1, 2, 3])).toBe(markup([0, 1, 2, 3]));
  });

  it("varies tokens with the same traits by their seed", () => {
    expect(markup([0, 0, 0, 0], "a")).not.toBe(markup([0, 0, 0, 0], "b"));
  });

  it("changes the image for every trait", () => {
    for (let t = 0; t < traits.length; t++) {
      const changed = [0, 0, 0, 0];
      changed[t] = 1;
      expect(markup(changed), traits[t]!.name).not.toBe(markup([0, 0, 0, 0]));
    }
  });

  it("draws a removed trait as its most common value", () => {
    // Without Palette, the art uses Bauhaus, the Palette value with most weight.
    expect(markup([0, 0, 0], "token", traits.slice(1))).toBe(
      markup([0, 0, 0, 0]),
    );
  });

  it("names the traits for screen readers and marks the tier", () => {
    const { getByRole } = render(
      <Artwork traits={traits} rolled={[5, 3, 2, 3]} seed="token" />,
    );
    const image = getByRole("img");
    expect(image.getAttribute("aria-label")).toBe(
      "Palette: Gold, Composition: Scattered, Density: Dense, Accent: Sun",
    );
    expect(image.getAttribute("data-tier")).toBe("legendary");
  });
});
