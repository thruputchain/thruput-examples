// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Critter } from "./critter";
import { oneIn, roll, seeded, share, tier, tokenTier } from "./rarity";
import { DEMO_DROP } from "../contracts/drops";

const traits = DEMO_DROP.traits;

describe("rarity", () => {
  it("turns weights into chances and tiers", () => {
    expect(share(traits[0]!, 0)).toBeCloseTo(0.45);
    expect(tier(share(traits[0]!, 0))).toBe("common");
    expect(tier(share(traits[0]!, 2))).toBe("uncommon");
    expect(tier(share(traits[1]!, 3))).toBe("rare");
    expect(tier(share(traits[2]!, 3))).toBe("legendary");
  });

  it("uses the rarest value as the token's tier, and multiplies chances", () => {
    expect(tokenTier(traits, [0, 0, 0, 0])).toBe("common");
    expect(tokenTier(traits, [0, 0, 3, 0])).toBe("legendary");
    // 0.45 × 0.40 × 0.50 × 0.55 ≈ 0.0495, so about 1 in 20.
    expect(oneIn(traits, [0, 0, 0, 0])).toBe(20);
  });

  it("rolls each value about as often as its weight", () => {
    const random = seeded(new Uint8Array([1, 2, 3]));
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 20_000; i++) counts[roll(traits, random)[0]!]!++;
    expect(counts[0]! / 20_000).toBeCloseTo(0.45, 1);
    expect(counts[3]! / 20_000).toBeCloseTo(0.05, 1);
  });

  it("repeats a seeded sequence", () => {
    const a = seeded(new Uint8Array([9]));
    const b = seeded(new Uint8Array([9]));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("critter", () => {
  it("draws the same traits the same way, and different traits differently", () => {
    const markup = (rolled: number[]) => {
      const { container, unmount } = render(
        <Critter traits={traits} rolled={rolled} />,
      );
      // useId values differ between renders; the drawing must not.
      const html = container.innerHTML.replace(/_r_[^_"]*_/g, "id");
      unmount();
      return html;
    };
    expect(markup([0, 1, 2, 3])).toBe(markup([0, 1, 2, 3]));
    expect(markup([0, 1, 2, 3])).not.toBe(markup([3, 1, 2, 3]));
  });

  it("names the traits for screen readers, and skips a value named None", () => {
    const { getByRole } = render(
      <Critter traits={traits} rolled={[3, 3, 3, 0]} />,
    );
    const image = getByRole("img");
    expect(image.getAttribute("aria-label")).toBe(
      "Background: Gold, Body: Crystal, Eyes: Laser, Accessory: None",
    );
    expect(image.getAttribute("data-tier")).toBe("legendary");
  });
});
