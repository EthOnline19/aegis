import { describe, expect, it } from "vitest";
import {
  computePremium,
  expectedMonthlyUsd,
  multiplierOf,
  pricingEngine,
  type PricingEvent,
} from "../src/pricing.ts";
import { buildResume } from "../src/resume.ts";

/**
 * Live integration against the real @repayd/pricing engine (§12).
 *
 * Two event sets:
 * - FRESH: sdk + kya only — the §35 demo figure's provenance:
 *   sdk_discount (−10%) × kya_discount (−20%) = 0.72x.
 * - DEMO: the Step-4 run's event stream (clean days + attempt + covered
 *   claim $135) — prices the NEXT term higher under §12 (claim load ×3).
 */

const NOW = Date.UTC(2026, 8, 12);
const day = 86_400_000;

const FRESH: PricingEvent[] = [
  { kind: "kya_verified", at: NOW - 30 * day },
  { kind: "sdk_installed", at: NOW - 30 * day },
];

const DEMO: PricingEvent[] = [
  { kind: "sdk_installed", at: NOW - 180 * day },
  { kind: "kya_verified", at: NOW - 180 * day },
  ...[3, 2, 1, 0].map((d) => ({ kind: "clean_day" as const, at: NOW - d * day })),
  { kind: "attempted_breach", at: NOW - 1 * day },
  { kind: "covered_claim", at: NOW - 1 * day, amountUsd: 135 },
];

const POLICY = { coverageCapUsd: 2500 };

describe("live @repayd/pricing integration", () => {
  it("fresh quote: sdk × kya discounts = 0.72x → $36.00/mo on a $2,500 cap", () => {
    const premium = computePremium(POLICY, FRESH);
    expect(multiplierOf(premium)).toBeCloseTo(0.72, 6);
    expect(premium.monthlyPremiumUsd).toBeCloseTo(36, 4);
    expect(premium.baseRatePct).toBe(2);
  });

  it("post-claim demo stream: claim load ×3 within 180d lifts the multiplier above 1", () => {
    const premium = computePremium(POLICY, DEMO);
    expect(multiplierOf(premium)).toBeGreaterThan(1);
    // engine output is consistent with its own published formula
    expect(premium.monthlyPremiumUsd).toBeCloseTo(expectedMonthlyUsd(premium, 2500), 4);
  });

  it("every multiplier carries a provenance label and a detail string", () => {
    const premium = computePremium(POLICY, DEMO);
    for (const m of premium.multipliers) {
      expect(["VERIFIED", "COMPUTED"]).toContain(m.provenance);
      expect(m.detail.length).toBeGreaterThan(0);
    }
  });

  it("pricingEngine and the direct export agree (one engine, no divergence)", () => {
    expect(pricingEngine.computePremium(POLICY, DEMO)).toEqual(computePremium(POLICY, DEMO));
  });

  it("the §35 résumé's 0.72x is the fresh quote; next-term post-claim is not 0.72x", () => {
    const fresh = computePremium(POLICY, FRESH);
    const resume = buildResume({
      policy: { version: 4, capUsd: 2500, poolHealthy: true },
      driving: {
        cleanDays: 179,
        score: 94,
        premiumMultiplier: multiplierOf(fresh),
      },
      claims: { covered: 1, attempted: 1, payoutsUsd: [135] },
      alibi: { installed: true, instructionChainLive: true },
      backing: { worldIdVerified: true },
      status: "ACTIVE",
    });
    expect(resume.DRIVING.text).toContain("premium 0.72x");
    const postClaim = computePremium(POLICY, DEMO);
    expect(multiplierOf(postClaim)).not.toBeCloseTo(0.72, 2);
  });
});
