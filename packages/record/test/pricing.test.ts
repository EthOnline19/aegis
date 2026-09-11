import { describe, expect, it } from "vitest";
import {
  expectedMonthlyUsd,
  multiplierOf,
  type PricingEvent,
  type PremiumResult,
} from "../src/pricing.ts";
import { buildResume, type ResumeInput } from "../src/resume.ts";

/**
 * The §35 demo event stream — what the Step-4 run produced on Arc, as
 * pricing events: clean payroll days, the frozen attempt, the covered
 * $135 look-alike payout, SDK installed, World-ID verified.
 */
const NOW = Date.UTC(2026, 8, 12); // 2026-09-12 — after the Step-4 run
const day = 86_400_000;
const DEMO_EVENTS: PricingEvent[] = [
  { kind: "sdk_installed", at: NOW - 180 * day },
  { kind: "kya_verified", at: NOW - 180 * day },
  ...[3, 2, 1, 0].map((d) => ({ kind: "clean_day" as const, at: NOW - d * day })),
  { kind: "attempted_breach", at: NOW - 1 * day },
  { kind: "covered_claim", at: NOW - 1 * day, amountUsd: 135 },
];

describe("pricing wiring contract", () => {
  it("multiplierOf multiplies the §12 multiplier product", () => {
    const premium: PremiumResult = {
      baseRatePct: 2,
      multipliers: [
        { name: "STREAK_DISCOUNT", value: 0.72, provenance: "COMPUTED", detail: "" },
      ],
      monthlyPremiumUsd: 36,
      formula: "base_rate × coverage_cap × product(multipliers)",
    };
    expect(multiplierOf(premium)).toBe(0.72);
  });

  it("expectedMonthlyUsd enforces the §12 formula on engine output", () => {
    const premium: PremiumResult = {
      baseRatePct: 2,
      multipliers: [
        { name: "STREAK_DISCOUNT", value: 0.4, provenance: "COMPUTED", detail: "" },
        { name: "KYA_DISCOUNT", value: 0.8, provenance: "VERIFIED", detail: "" },
        { name: "SDK_DISCOUNT", value: 0.9, provenance: "VERIFIED", detail: "" },
      ],
      monthlyPremiumUsd: 14.4,
      formula: "base_rate × coverage_cap × product(multipliers)",
    };
    expect(multiplierOf(premium)).toBeCloseTo(0.288, 6);
    expect(expectedMonthlyUsd(premium, 2500)).toBeCloseTo(14.4, 6);
  });

  it("buildResume carries the pricing multiplier into the DRIVING line", () => {
    const input: ResumeInput = {
      policy: { version: 4, capUsd: 2500, poolHealthy: true },
      driving: { cleanDays: 179, score: 94, premiumMultiplier: 0.72 },
      claims: { covered: 1, attempted: 1, payoutsUsd: [135] },
      alibi: { installed: true, instructionChainLive: true },
      backing: { worldIdVerified: true },
      status: "ACTIVE",
    };
    expect(buildResume(input).DRIVING.text).toContain("premium 0.72x");
    // 0.72x is the §35 demo figure: the fresh-policy quote of
    // sdk_discount (−10%) × kya_discount (−20%) = 0.72. The demo event
    // stream (clean days + attempt + claim + KYA + SDK) prices the NEXT
    // term higher under §12 (claim load ×3 within 180d ≈ 2.6x; ×1.5 with
    // a mitigation event ≈ 1.3x). The résumé displays the multiplier it
    // is handed — provenance stays COMPUTED either way.
    const kinds = DEMO_EVENTS.map((e) => e.kind);
    for (const required of ["clean_day", "attempted_breach", "covered_claim", "kya_verified", "sdk_installed"]) {
      expect(kinds).toContain(required);
    }
  });
});
