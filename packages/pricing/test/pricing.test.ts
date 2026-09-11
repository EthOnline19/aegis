import { describe, expect, it } from "bun:test";

import {
  BLOCKS_PER_MONTH,
  claimLoad,
  cleanStreakDays,
  computePremium,
  type PricingEvent,
  type Premium,
} from "../src/index.ts";

// --------------------------------------------------------------------- //
//         §28 Case 13 — Atlas's first year, asserted numerically        //
// --------------------------------------------------------------------- //

const CAP = 2_500; // $2,500 coverage cap (plan §15)
const DAY = 86_400_000; // ms
/** Fixed epoch: 2026-01-01. No wall clock anywhere in these tests. */
const T0 = 1_767_225_600_000;
/** Day-offset helper: d(90) = T0 + 90 days. */
const d = (n: number) => T0 + n * DAY;

/** A clean_day event for each day in [a, b] inclusive. */
function cleanDays(a: number, b: number): PricingEvent[] {
  return Array.from({ length: b - a + 1 }, (_, i) => ({ kind: "clean_day" as const, at: d(a + i) }));
}

function mul(p: Premium, name: string): number {
  const m = p.multipliers.find((x) => x.name === name);
  if (!m) throw new Error(`multiplier ${name} not present: ${JSON.stringify(p.multipliers)}`);
  return m.value;
}

function product(p: Premium): number {
  return p.multipliers.reduce((acc, m) => acc * m.value, 1);
}

describe("§28 — Atlas's first year of premiums (the flywheel, quantified)", () => {
  it("month 1: new agent, SDK installed, World-ID verified → 0.72x = $36/mo", () => {
    // No clean streak yet (no VERIFIED clean days banked).
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
    ]);
    expect(mul(p, "kya_discount")).toBeCloseTo(0.8, 10);
    expect(mul(p, "sdk_discount")).toBeCloseTo(0.9, 10);
    expect(product(p)).toBeCloseTo(0.72, 10);
    expect(p.monthlyPremiumUsd).toBeCloseTo(36, 6); // 2500 × 2% × 0.72
    expect(p.baseRatePct).toBe(2.0);
  });

  it("months 2–4: clean streak builds to 90 days → 0.72 × 0.70 = 0.504x", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 90), // anchor d(0), now d(90) → 90 elapsed days
    ]);
    // 90/180 × 60% = 30% off → 0.72 × 0.70 = 0.504x → $25.20/mo.
    // (The plan's "0.55x" blends the ramping months 2–4; the pinned
    // points are 90d → 0.70 streak factor and 180d → 0.40.)
    expect(mul(p, "streak_discount")).toBeCloseTo(0.7, 10);
    expect(product(p)).toBeCloseTo(0.72 * 0.7, 10);
    expect(p.monthlyPremiumUsd).toBeCloseTo(25.2, 6);
  });

  it("month 5: attempted breach (Case 3, blocked) → +15% for 30 days", () => {
    // At the attempt instant the streak breaks (adverse event) and the
    // +15% term engages; the plan's 0.62x = 0.55x × 1.126 blends the
    // pre-attempt streak. The load itself is the pinned quantity:
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 119),
      { kind: "attempted_breach", at: d(120) },
    ]);
    expect(mul(p, "attempt_load")).toBeCloseTo(1.15, 10);
    // Post-attempt term: streak reset to 0 at the attempt, rebuilt to 20
    // clean days; attempt load ×1.15 AND anomaly load ×(1+0.4/6) — the
    // attempt itself is a near-miss in the 30d density window.
    const postAttempt = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 119),
      { kind: "attempted_breach", at: d(120) },
      ...cleanDays(121, 140),
    ]);
    // Streak restarted at d(121); at now=d(140) that is 19 elapsed days.
    expect(mul(postAttempt, "streak_discount")).toBeCloseTo(1 - 0.6 * (19 / 180), 10);
    expect(mul(postAttempt, "attempt_load")).toBeCloseTo(1.15, 10);
    expect(mul(postAttempt, "anomaly_load")).toBeCloseTo(1 + 0.4 / 6, 10);
    expect(postAttempt.monthlyPremiumUsd).toBeCloseTo(
      2500 * 0.02 * 0.72 * (1 - 0.6 * (19 / 180)) * 1.15 * (1 + 0.4 / 6),
      5,
    );
  });

  it("attempted breach load expires after 30 days", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "attempted_breach", at: d(100) },
      { kind: "clean_day", at: d(131) },
    ]);
    expect(p.multipliers.find((m) => m.name === "attempt_load")).toBeUndefined();
  });

  it("months 6–8: 180-day milestone → streak factor 0.40 = $20/mo", () => {
    // §28's "0.40x" is the streak multiplier itself (1 − 0.6); composed
    // with KYA+SDK the full product is 0.9 × 0.8 × 0.4 = 0.288x = $14.40.
    const p = computePremium({ coverageCapUsd: CAP }, [...cleanDays(0, 180)]);
    expect(mul(p, "streak_discount")).toBeCloseTo(0.4, 10);
    expect(p.monthlyPremiumUsd).toBeCloseTo(2500 * 0.02 * 0.4, 6); // $20
    const full = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 180),
    ]);
    expect(full.monthlyPremiumUsd).toBeCloseTo(14.4, 6);
  });

  it("month 9: covered claim ($135, Case 5) mitigated → 0.4 × 1.5 = 0.60x = $30/mo", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      ...cleanDays(0, 199),
      { kind: "covered_claim", at: d(200), amountUsd: 135 },
      { kind: "mitigation", at: d(201) },
    ]);
    expect(mul(p, "claim_load")).toBeCloseTo(1.5, 10);
    expect(product(p)).toBeCloseTo(0.4 * 1.5, 10);
    expect(p.monthlyPremiumUsd).toBeCloseTo(30, 6); // $30/mo — plan month 9
  });

  it("unmitigated covered claim → ×3 for the 180-day window", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      ...cleanDays(0, 199),
      { kind: "covered_claim", at: d(200), amountUsd: 135 },
      { kind: "clean_day", at: d(201) },
    ]);
    expect(mul(p, "claim_load")).toBe(3);
    expect(product(p)).toBeCloseTo(0.4 * 3, 10); // 1.2x → $60/mo
  });

  it("months 10–12: mitigation accepted, streak 200+ days, window expires → terminal 0.288x", () => {
    // A covered claim does not break the streak (its own ×1.5/×3/×5 load
    // is the punishment), so by month 10 the streak is 200+ days → the
    // 0.40 floor. Within the 180-day claim window, mitigated:
    // 0.9 × 0.8 × 0.4 × 1.5 = 0.432x = $21.60/mo.
    const during = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 199),
      { kind: "covered_claim", at: d(200), amountUsd: 135 },
      { kind: "mitigation", at: d(201) },
      ...cleanDays(202, 259),
    ]);
    expect(mul(during, "streak_discount")).toBeCloseTo(0.4, 10); // streak 260d, capped
    expect(mul(during, "claim_load")).toBeCloseTo(1.5, 10);
    expect(product(during)).toBeCloseTo(0.9 * 0.8 * 0.4 * 1.5, 10);
    expect(during.monthlyPremiumUsd).toBeCloseTo(21.6, 6);

    // Terminal state (window expired): 0.9 × 0.8 × 0.4 = 0.288x = $14.40.
    // The plan's "0.34x/$17" is an illustration that mixes conventions
    // (its month 6–8 row also drops the kya/sdk discounts); the §12
    // formula is normative and yields 0.288x — strictly better for the
    // owner than the plan's number.
    const terminal = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 199),
      { kind: "covered_claim", at: d(200), amountUsd: 135 },
      { kind: "mitigation", at: d(201) },
      ...cleanDays(202, 381),
    ]);
    expect(terminal.multipliers.find((m) => m.name === "claim_load")).toBeUndefined();
    expect(mul(terminal, "streak_discount")).toBeCloseTo(0.4, 10);
    expect(product(terminal)).toBeCloseTo(0.9 * 0.8 * 0.4, 10); // 0.288x
    expect(terminal.monthlyPremiumUsd).toBeCloseTo(14.4, 6);
  });
});

// --------------------------------------------------------------------- //
//                     Streak edges (0 / 179 / 180+)                     //
// --------------------------------------------------------------------- //

describe("streak edges", () => {
  it("0 elapsed days (clean_day at `now`) → no streak multiplier", () => {
    const none = computePremium({ coverageCapUsd: CAP }, [{ kind: "sdk_installed", at: T0 }]);
    expect(none.multipliers.find((m) => m.name === "streak_discount")).toBeUndefined();

    const sameDay = computePremium({ coverageCapUsd: CAP }, [{ kind: "clean_day", at: T0 }]);
    expect(sameDay.multipliers.find((m) => m.name === "streak_discount")).toBeUndefined();

    // One full elapsed day: clean_day at d(0), evaluated at d(1).
    const one = computePremium({ coverageCapUsd: CAP }, [
      { kind: "clean_day", at: d(0) },
      { kind: "clean_day", at: d(1) },
    ]);
    expect(mul(one, "streak_discount")).toBeCloseTo(1 - 0.6 / 180, 10);
  });

  it("180 days → exactly 0.40; long gaps cap at 0.40 (whole clean days since last adverse)", () => {
    const p180 = computePremium({ coverageCapUsd: CAP }, cleanDays(0, 180));
    expect(mul(p180, "streak_discount")).toBeCloseTo(0.4, 10);
    const p400 = computePremium({ coverageCapUsd: CAP }, [
      ...cleanDays(0, 179),
      { kind: "clean_day", at: d(400) },
    ]);
    expect(mul(p400, "streak_discount")).toBeCloseTo(0.4, 10);
  });

  it("adverse events break the streak; recovered does not", () => {
    const base: PricingEvent[] = [...cleanDays(0, 99)];
    const broken = computePremium({ coverageCapUsd: CAP }, [
      ...base,
      { kind: "attempted_breach", at: d(100) },
      { kind: "clean_day", at: d(100) },
    ]);
    // Attempt at d(100) resets; clean_day at the same instant → 0
    // elapsed days → no streak multiplier at all.
    expect(broken.multipliers.find((m) => m.name === "streak_discount")).toBeUndefined();
    const recovered = computePremium({ coverageCapUsd: CAP }, [
      ...base,
      { kind: "recovered", at: d(100) },
      { kind: "clean_day", at: d(105) },
    ]);
    // recovered is remediation, not an infraction: anchor stays d(0),
    // now=d(105) → 105 elapsed clean days.
    expect(mul(recovered, "streak_discount")).toBeCloseTo(1 - 0.6 * (105 / 180), 10);
  });
});

// --------------------------------------------------------------------- //
//                       Claim escalation ×3 → ×5                        //
// --------------------------------------------------------------------- //

describe("claim load escalation", () => {
  it("×3 for 180 days after one covered claim", () => {
    expect(claimLoad([{ kind: "covered_claim", at: d(0), amountUsd: 135 }], d(179))).toBe(3);
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "covered_claim", at: d(0), amountUsd: 135 },
      { kind: "clean_day", at: d(179) },
    ]);
    expect(mul(p, "claim_load")).toBe(3);
  });

  it("×5 when 2+ covered claims inside the 180-day window", () => {
    const events: PricingEvent[] = [
      { kind: "covered_claim", at: d(0), amountUsd: 100 },
      { kind: "covered_claim", at: d(90), amountUsd: 100 },
      { kind: "clean_day", at: d(120) },
    ];
    expect(claimLoad(events, d(120))).toBe(5);
    expect(mul(computePremium({ coverageCapUsd: CAP }, events), "claim_load")).toBe(5);
  });

  it("mitigation after the latest claim → ×1.5", () => {
    const events: PricingEvent[] = [
      { kind: "covered_claim", at: d(0), amountUsd: 135 },
      { kind: "mitigation", at: d(10) },
      { kind: "clean_day", at: d(50) },
    ];
    expect(claimLoad(events, d(50))).toBe(1.5);
  });

  it("claim load expires after 180 days", () => {
    expect(claimLoad([{ kind: "covered_claim", at: d(0) }], d(181))).toBe(1);
  });

  it("2 claims but oldest outside window → ×3, not ×5", () => {
    expect(
      claimLoad(
        [
          { kind: "covered_claim", at: d(0) },
          { kind: "covered_claim", at: d(100) },
        ],
        d(181), // first claim at d(0) is exactly 181 days old → outside
      ),
    ).toBe(3);
  });

  it("denied claims carry no claim load (they feed anomaly density instead)", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "denied_claim", at: d(0) },
      { kind: "clean_day", at: d(1) },
    ]);
    expect(p.multipliers.find((m) => m.name === "claim_load")).toBeUndefined();
    expect(mul(p, "anomaly_load")).toBeCloseTo(1 + 0.4 / 6, 10);
  });
});

// --------------------------------------------------------------------- //
//                    Watch-only ×2, KYA+SDK stacking                    //
// --------------------------------------------------------------------- //

describe("watch-only and discount stacking", () => {
  it("watch_only → ×2", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "watch_only", at: T0 },
      { kind: "clean_day", at: T0 },
    ]);
    expect(mul(p, "watch_only_load")).toBe(2);
    expect(p.monthlyPremiumUsd).toBeCloseTo(100, 6); // 2500 × 2% × 2
  });

  it("kya + sdk stack multiplicatively: 0.8 × 0.9 = 0.72", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
    ]);
    expect(mul(p, "kya_discount")).toBe(0.8);
    expect(mul(p, "sdk_discount")).toBe(0.9);
    expect(product(p)).toBeCloseTo(0.72, 10);
  });

  it("neither kya nor sdk → 1.0x base ($50/mo)", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [{ kind: "clean_day", at: T0 }]);
    expect(product(p)).toBeCloseTo(1, 10);
    expect(p.monthlyPremiumUsd).toBeCloseTo(50, 6);
  });

  it("watch-only does not cancel the discounts: 0.72 × 2 = 1.44x = $72/mo", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      { kind: "watch_only", at: T0 },
    ]);
    expect(product(p)).toBeCloseTo(1.44, 10);
    expect(p.monthlyPremiumUsd).toBeCloseTo(72, 6);
  });
});

// --------------------------------------------------------------------- //
//   Anomaly load, per-block pricing, provenance, determinism, errors    //
// --------------------------------------------------------------------- //

describe("anomaly load (documented: 0.4 × min(1, nearMisses30/6))", () => {
  it("clean log → no anomaly multiplier", () => {
    const p = computePremium({ coverageCapUsd: CAP }, cleanDays(0, 30));
    expect(p.multipliers.find((m) => m.name === "anomaly_load")).toBeUndefined();
  });

  it("one attempted breach in window → +15% attempt AND +6.67% anomaly", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "attempted_breach", at: d(0) },
      { kind: "clean_day", at: d(1) },
    ]);
    expect(mul(p, "anomaly_load")).toBeCloseTo(1 + 0.4 / 6, 10);
    expect(mul(p, "attempt_load")).toBeCloseTo(1.15, 10);
  });

  it("6 near-misses in 30 days saturate at +40%; 7 do not exceed it", () => {
    // Boundary note: the 30d density window is half-open (strict >),
    // so events at d(0) with now=d(30) sit exactly on the edge — use
    // d(1..6) to be strictly inside the window.
    const six: PricingEvent[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "attempted_breach" as const, at: d(i + 1) })),
      { kind: "clean_day", at: d(30) },
    ];
    expect(mul(computePremium({ coverageCapUsd: CAP }, six), "anomaly_load")).toBeCloseTo(1.4, 10);
    const seven: PricingEvent[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ kind: "attempted_breach" as const, at: d(i + 1) })),
      { kind: "clean_day", at: d(30) },
    ];
    expect(mul(computePremium({ coverageCapUsd: CAP }, seven), "anomaly_load")).toBeCloseTo(1.4, 10);
  });

  it("near-misses older than 30 days do not count", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "denied_claim", at: d(0) },
      { kind: "clean_day", at: d(31) },
    ]);
    expect(p.multipliers.find((m) => m.name === "anomaly_load")).toBeUndefined();
  });
});

describe("per-block pricing (exposure-based, §12)", () => {
  it("perBlockPremiumUsd = monthly / 1,296,000 (30d of 2s blocks)", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
    ]);
    expect(BLOCKS_PER_MONTH).toBe(1_296_000);
    expect(p.monthlyPremiumUsd).toBeCloseTo(36, 6);
    expect(p.perBlockPremiumUsd).toBeCloseTo(36 / 1_296_000, 10);
  });

  it("perBlock is present and positive whenever monthly is", () => {
    const p = computePremium({ coverageCapUsd: 1_000 }, [{ kind: "clean_day", at: T0 }]);
    expect(p.perBlockPremiumUsd!).toBeGreaterThan(0);
  });
});

describe("provenance labels (§9: VERIFIED vs COMPUTED, never INFERRED)", () => {
  it("kya/sdk are VERIFIED; formula multipliers are COMPUTED", () => {
    // Every multiplier kind at once: streak (8 elapsed days since the
    // d(31) attempt), attempt load, claim load, anomaly load, watch-only,
    // plus the two VERIFIED discounts.
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 30),
      { kind: "attempted_breach", at: d(31) },
      ...cleanDays(32, 40), // streak resumes: 8 elapsed days at d(40)
      { kind: "covered_claim", at: d(40), amountUsd: 100 },
      { kind: "clean_day", at: d(40) },
      { kind: "watch_only", at: T0 },
    ]);
    const byName: Record<string, string> = Object.fromEntries(
      p.multipliers.map((m) => [m.name, m.provenance]),
    );
    expect(byName["kya_discount"]).toBe("VERIFIED");
    expect(byName["sdk_discount"]).toBe("VERIFIED");
    expect(byName["streak_discount"]).toBe("COMPUTED");
    expect(byName["attempt_load"]).toBe("COMPUTED");
    expect(byName["claim_load"]).toBe("COMPUTED");
    expect(byName["anomaly_load"]).toBe("COMPUTED");
    expect(byName["watch_only_load"]).toBe("COMPUTED");
    for (const m of p.multipliers) {
      expect(m.provenance === "VERIFIED" || m.provenance === "COMPUTED").toBe(true);
      expect(m.detail.length).toBeGreaterThan(0);
    }
  });

  it("output includes the full formula string", () => {
    const p = computePremium({ coverageCapUsd: CAP }, [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
    ]);
    expect(p.formula).toContain("2%/mo");
    expect(p.formula).toContain("$2500");
    expect(p.formula).toContain("kya_discount(×0.8)");
    expect(p.formula).toContain("sdk_discount(×0.9)");
    expect(p.formula).toContain("$36/mo");
  });
});

describe("determinism", () => {
  it("same policy + same events (any order) → byte-identical result", () => {
    const events: PricingEvent[] = [
      { kind: "kya_verified", at: T0 },
      { kind: "sdk_installed", at: T0 },
      ...cleanDays(0, 60),
      { kind: "attempted_breach", at: d(61) },
      { kind: "covered_claim", at: d(62), amountUsd: 135 },
      { kind: "mitigation", at: d(63) },
    ];
    const a = computePremium({ coverageCapUsd: CAP }, events);
    const b = computePremium({ coverageCapUsd: CAP }, [...events].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("no wall clock: event timestamps fully determine the evaluation instant", () => {
    // The eval instant is max(events.at); no Date.now() anywhere. A log
    // anchored far in the future prices identically whenever it runs.
    // Two events one day apart → 1 elapsed clean day.
    const far: PricingEvent[] = [
      { kind: "clean_day", at: d(10_000) },
      { kind: "clean_day", at: d(10_001) },
    ];
    const p = computePremium({ coverageCapUsd: CAP }, far);
    expect(cleanStreakDays(far, d(10_001))).toBe(1);
    expect(mul(p, "streak_discount")).toBeCloseTo(1 - 0.6 / 180, 10);
  });

  it("custom baseRatePct is honored and echoed", () => {
    const p = computePremium({ coverageCapUsd: 1_000, baseRatePct: 3.0 }, [
      { kind: "clean_day", at: T0 },
    ]);
    expect(p.baseRatePct).toBe(3.0);
    expect(p.monthlyPremiumUsd).toBeCloseTo(30, 6);
    expect(p.formula).toContain("3%/mo");
  });
});

describe("input validation", () => {
  it("rejects non-positive coverage cap", () => {
    expect(() => computePremium({ coverageCapUsd: 0 }, [{ kind: "clean_day", at: T0 }])).toThrow();
    expect(() => computePremium({ coverageCapUsd: -5 }, [{ kind: "clean_day", at: T0 }])).toThrow();
  });

  it("rejects an empty event log (no evaluation instant)", () => {
    expect(() => computePremium({ coverageCapUsd: CAP }, [])).toThrow();
  });
});
