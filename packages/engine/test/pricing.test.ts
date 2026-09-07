import { describe, expect, it } from "vitest";

import { quote, type DrivingRecord } from "../src/pricing.ts";

// --------------------------------------------------------------------- //
//              Case 13: Atlas's first year of premiums                  //
// --------------------------------------------------------------------- //

const CAP = 2_500_000_000n; // $2,500 coverage
const NOW = 1_772_000_000;

function record(overrides: Partial<DrivingRecord> = {}): DrivingRecord {
  return {
    cleanStreakDays: 0,
    anomalyLoad: 0,
    attemptedBreaches: [],
    recentClaims: [],
    lifetimeClaims: 0,
    worldIdVerified: true,
    sdkInstalled: true,
    watchOnly: false,
    now: NOW,
    ...overrides,
  };
}

describe("pricing engine — the telematics flywheel", () => {
  it("month 1: new agent, KYA + SDK → 0.72x ≈ $36/mo", () => {
    const q = quote(record(), CAP);
    expect(q.multiplier).toBeCloseTo(0.9 * 0.8, 5);
    expect(Number(q.monthlyPremium)).toBeGreaterThan(35e6);
    expect(Number(q.monthlyPremium)).toBeLessThan(37e6);
  });

  it("months 2-4: streak builds to 90 days → ≈0.55x…0.46x", () => {
    const q90 = quote(record({ cleanStreakDays: 90 }), CAP);
    // streak discount at 90/180 = half of 60% = 30% off → 0.9*0.8*0.7 = 0.504
    expect(q90.multiplier).toBeCloseTo(0.9 * 0.8 * 0.7, 5);
  });

  it("180-day clean streak reaches the full −60% (plan §12 formula)", () => {
    const q = quote(record({ cleanStreakDays: 180 }), CAP);
    // product form: KYA(0.8) × SDK(0.9) × streak(1−0.6) = 0.288x → $14.40/mo.
    // The plan §28 table's "0.40x" is the streak multiplier itself at 180d
    // (1 − 0.6); composed with KYA+SDK it yields 0.288x. The §12 formula is
    // the normative source: premium = base × cap × product(multipliers).
    expect(q.multiplier).toBeCloseTo(0.8 * 0.9 * 0.4, 5);
    expect(Number(q.monthlyPremium)).toBeCloseTo(14.4e6, -5);
    // And the streak-only multiplier at 180d is exactly the plan's 0.40:
    const noDiscounts = quote(
      record({ cleanStreakDays: 180, worldIdVerified: false, sdkInstalled: false }),
      CAP,
    );
    expect(noDiscounts.multiplier).toBeCloseTo(0.4, 5);
  });

  it("month 5: attempted breach (Case 3, blocked) → +15% for 30 days", () => {
    const q = quote(
      record({ cleanStreakDays: 90, attemptedBreaches: [NOW - 86_400] }),
      CAP,
    );
    expect(q.multiplier).toBeCloseTo(0.9 * 0.8 * 0.7 * 1.15, 5);
    expect(q.reasons.some((r) => r.tag === "ATTEMPT_LOAD")).toBe(true);
  });

  it("attempted breach load expires after 30 days", () => {
    const q = quote(
      record({ cleanStreakDays: 90, attemptedBreaches: [NOW - 31 * 86_400] }),
      CAP,
    );
    expect(q.reasons.some((r) => r.tag === "ATTEMPT_LOAD")).toBe(false);
  });

  it("month 9: covered claim (Case 5) → ×3 for 6 months", () => {
    const q = quote(
      record({ cleanStreakDays: 30, recentClaims: [NOW - 86_400], lifetimeClaims: 1 }),
      CAP,
    );
    expect(q.reasons.some((r) => r.tag === "CLAIM_LOAD")).toBe(true);
    expect(q.multiplier).toBeCloseTo(0.9 * 0.8 * (1 - 0.1) * 3, 5); // 30d streak ≈ 10% off
  });

  it("2+ lifetime claims → ×5", () => {
    const q = quote(
      record({ recentClaims: [NOW - 86_400], lifetimeClaims: 2 }),
      CAP,
    );
    expect(q.multiplier).toBeCloseTo(0.9 * 0.8 * 5, 5);
  });

  it("watch-only mode → ×2 moral hazard load", () => {
    const q = quote(record({ watchOnly: true }), CAP);
    expect(q.multiplier).toBeCloseTo(0.9 * 0.8 * 2, 5);
    expect(q.reasons.some((r) => r.tag === "WATCH_ONLY_LOAD")).toBe(true);
  });

  it("no World ID, no SDK → full 1.0x base", () => {
    const q = quote(record({ worldIdVerified: false, sdkInstalled: false }), CAP);
    expect(q.multiplier).toBe(1);
    expect(Number(q.monthlyPremium)).toBe(50e6); // exactly $50 = 2% of $2,500
  });

  it("deterministic: same record → same quote", () => {
    const r = record({ cleanStreakDays: 120, anomalyLoad: 0.3 });
    expect(quote(r, CAP)).toEqual(quote(r, CAP));
  });
});
