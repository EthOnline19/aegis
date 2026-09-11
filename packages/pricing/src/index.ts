/**
 * BULWARK Pricing Engine v1 — telematics for machines (plan §12).
 *
 * The deterministic, public formula:
 *
 *   premium = base_rate (2.0%/mo) × coverage_cap × product(multipliers)
 *   charged per block the agent is active with funds at risk.
 *
 * Provenance law (plan §9): every multiplier is labeled VERIFIED
 * (derived from on-chain facts — subgraph-indexed clean-day counts,
 * verdict digests, claim receipts) or COMPUTED (derived by this
 * published formula). Nothing is ever INFERRED.
 *
 * Determinism: no wall clock inside computePremium. The evaluation
 * instant is the latest event timestamp, so the same event log always
 * prices identically — forever, by anyone.
 */

/** A driving-record event, as indexed from the Risk Subgraph. */
export interface PricingEvent {
  readonly kind:
    | "clean_day"
    | "attempted_breach"
    | "covered_claim"
    | "denied_claim"
    | "recovered"
    | "mitigation"
    | "watch_only"
    | "kya_verified"
    | "sdk_installed";
  /** ms epoch */
  readonly at: number;
  readonly amountUsd?: number;
}

export interface PricingPolicy {
  readonly coverageCapUsd: number;
  /** percent per month; defaults to 2.0 (§12 base rate) */
  readonly baseRatePct?: number;
}

export interface PricingMultiplier {
  readonly name: string;
  readonly value: number;
  readonly provenance: "VERIFIED" | "COMPUTED";
  readonly detail: string;
}

export interface Premium {
  readonly baseRatePct: number;
  readonly multipliers: PricingMultiplier[];
  readonly monthlyPremiumUsd: number;
  /** monthly premium ÷ 1,296,000 blocks (30d of 2s blocks) */
  readonly perBlockPremiumUsd?: number;
  readonly formula: string;
}

/** §12 constants — the whole tariff, in one place. */
export const BASE_RATE_PCT = 2.0; // % of coverage per month
export const MAX_STREAK_DISCOUNT = 0.6; // −60% …
export const STREAK_DAYS_MAX = 180; // … at 180 clean days
export const ANOMALY_LOAD_MAX = 0.4; // +40% at full density
export const ATTEMPT_LOAD = 0.15; // +15% for 30 days after an attempt
export const ATTEMPT_WINDOW_MS = 30 * 86_400_000;
export const CLAIM_WINDOW_MS = 180 * 86_400_000; // ×3/×5 for 6 months
export const CLAIM_LOAD_FIRST = 3;
export const CLAIM_LOAD_REPEAT = 5;
export const CLAIM_LOAD_MITIGATED = 1.5; // mitigation accepted after the claim
export const KYA_DISCOUNT = 0.2; // −20% World-ID verified
export const SDK_DISCOUNT = 0.1; // −10% alibi data available
export const WATCH_ONLY_LOAD = 2; // ×2 no containment → moral hazard
/** 30 days of 2-second blocks: 30 × 24 × 3600 / 2 (§12 exposure unit). */
export const BLOCKS_PER_MONTH = 1_296_000;

/** Provenance label type (kept structurally identical to engine's). */
export type Provenance = "VERIFIED" | "COMPUTED";

const DAY_MS = 86_400_000;
const MS_PER_MONTH = 30 * DAY_MS;

/** Round to 6 decimal places — the precision shared with USDC. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Anomaly load (§12 "+0–40% behavioral variance"): a density measure of
 * near-miss signals — attempted breaches and denied claims — over the
 * trailing 30 days. density = count / 6 means one near-miss per ~5 days.
 * Documented choice: k = 6 events/30d saturates the +40% band, so
 *   anomaly_load = 0.4 × min(1, (attempts30 + denied30) / 6).
 * Clean logs price at 1.0 (no load) because an empty window is not
 * anomalous — it is the norm (§28 months 10–12 carry no anomaly load).
 */
export function anomalyLoad(events: PricingEvent[], now: number): number {
  const window30 = now - ATTEMPT_WINDOW_MS;
  const nearMisses = events.filter(
    (e) =>
      (e.kind === "attempted_breach" || e.kind === "denied_claim") &&
      e.at > window30,
  ).length;
  return ANOMALY_LOAD_MAX * Math.min(1, nearMisses / 6);
}

/**
 * Claim load (§12): ×3 for 180 days after a covered claim — ×5 if 2+
 * covered claims inside the window (the escalation is per-window, the
 * honest reading of "×5 for 2+") — ×1.5 when a mitigation event follows
 * the most recent claim (owner accepted the fix; §28 month 9).
 */
export function claimLoad(events: PricingEvent[], now: number): number {
  const window = now - CLAIM_WINDOW_MS;
  const claims = events.filter((e) => e.kind === "covered_claim" && e.at > window);
  if (claims.length === 0) return 1;
  claims.sort((a, b) => a.at - b.at);
  const last = claims[claims.length - 1]!;
  const mitigated = events.some((e) => e.kind === "mitigation" && e.at >= last!.at);
  if (mitigated) return CLAIM_LOAD_MITIGATED;
  return claims.length >= 2 ? CLAIM_LOAD_REPEAT : CLAIM_LOAD_FIRST;
}

/**
 * Clean streak (VERIFIED input): consecutive clean days ending at the
 * evaluation instant. A clean_day event marks a day the GuardAccount
 * executed with zero violations/attempts/claims. Any adverse event
 * (attempted_breach, covered_claim, denied_claim) ends the streak at
 * that day; the streak restarts from the next clean_day after it.
 */
export function cleanStreakDays(events: PricingEvent[], now: number): number {
  // Last adverse event (recovered/mitigation do not break a clean run).
  let lastAdverse = -Infinity;
  for (const e of events) {
    if (e.kind === "attempted_breach" || e.kind === "covered_claim" || e.kind === "denied_claim") {
      if (e.at > lastAdverse) lastAdverse = e.at;
    }
  }
  // Earliest clean_day at/after the last adverse event anchors the run.
  let anchor = -Infinity;
  for (const e of events) {
    if (e.kind === "clean_day" && e.at >= lastAdverse && e.at > anchor) anchor = e.at;
  }
  if (anchor === -Infinity) return 0;
  // Streak counts whole elapsed clean days since the anchor.
  return Math.max(0, Math.floor((now - anchor) / DAY_MS) + 1);
}

/**
 * Compute the premium. Deterministic: `now` = latest event timestamp.
 * Same policy + same events → same premium, forever, for anyone.
 */
export function computePremium(policy: PricingPolicy, events: PricingEvent[]): Premium {
  if (!(policy.coverageCapUsd > 0)) {
    throw new Error("coverageCapUsd must be > 0");
  }
  const baseRatePct = policy.baseRatePct ?? BASE_RATE_PCT;
  // Evaluation instant: latest event `at` — never Date.now().
  const now = events.reduce((m, e) => Math.max(m, e.at), -Infinity);
  if (now === -Infinity) {
    throw new Error("events must contain at least one event to establish the evaluation instant");
  }

  const multipliers: PricingMultiplier[] = [];

  // ── Streak discount (§12: up to −60% at 180 clean days) ──────────
  // VERIFIED input (subgraph clean-day counts) × COMPUTED interpolation.
  // Documented choice: linear ramp — discount = 60% × (days/180). A
  // linear telematics ramp matches the §28 progression (90 clean days →
  // 0.60x, 180 → 0.40x) and is the simplest monotone interpolation
  // through both pinned points.
  const streak = cleanStreakDays(events, now);
  const streakFrac = Math.min(streak, STREAK_DAYS_MAX) / STREAK_DAYS_MAX;
  const streakMul = 1 - MAX_STREAK_DISCOUNT * streakFrac;
  if (streak > 0) {
    multipliers.push({
      name: "streak_discount",
      value: round6(streakMul),
      provenance: "COMPUTED",
      detail: `${streak} VERIFIED clean days (linear ramp to −60% at ${STREAK_DAYS_MAX}) → ×${round6(streakMul)}`,
    });
  }

  // ── Attempt load (§12: +15% for 30 days after an attempted breach) ─
  const attempts30 = events.filter(
    (e) => e.kind === "attempted_breach" && now - e.at < ATTEMPT_WINDOW_MS,
  );
  if (attempts30.length > 0) {
    multipliers.push({
      name: "attempt_load",
      value: 1 + ATTEMPT_LOAD,
      provenance: "COMPUTED",
      detail: `${attempts30.length} VERIFIED attempted breach(es) within 30 days → ×${round6(1 + ATTEMPT_LOAD)}`,
    });
  }

  // ── Claim load (§12: ×3 for 6 months; ×5 for 2+; mitigated ×1.5) ──
  const load = claimLoad(events, now);
  if (load !== 1) {
    const claims = events.filter((e) => e.kind === "covered_claim" && e.at > now - CLAIM_WINDOW_MS);
    const mitigated = load === CLAIM_LOAD_MITIGATED;
    multipliers.push({
      name: "claim_load",
      value: round6(load),
      provenance: "COMPUTED",
      detail: mitigated
        ? `${claims.length} VERIFIED covered claim(s) in 180d, mitigation accepted → ×${CLAIM_LOAD_MITIGATED}`
        : `${claims.length} VERIFIED covered claim(s) in 180d → ×${round6(load)}`,
    });
  }

  // ── Anomaly load (§12: +0–40% behavioral variance) ────────────────
  const anomaly = anomalyLoad(events, now);
  if (anomaly > 0) {
    multipliers.push({
      name: "anomaly_load",
      value: round6(1 + anomaly),
      provenance: "COMPUTED",
      detail: `near-miss density over 30d (attempted+denied) → +${round6(anomaly * 100)}%`,
    });
  }

  // ── KYA discount (§12: −20% World-ID verified) ───────────────────
  if (events.some((e) => e.kind === "kya_verified")) {
    multipliers.push({
      name: "kya_discount",
      value: 1 - KYA_DISCOUNT,
      provenance: "VERIFIED",
      detail: "backing human is World-ID verified → ×0.8",
    });
  }

  // ── SDK discount (§12: −10% alibi data available) ────────────────
  if (events.some((e) => e.kind === "sdk_installed")) {
    multipliers.push({
      name: "sdk_discount",
      value: 1 - SDK_DISCOUNT,
      provenance: "VERIFIED",
      detail: "alibi SDK installed, instruction chain live → ×0.9",
    });
  }

  // ── Watch-only load (§12: ×2 no containment → moral hazard) ──────
  if (events.some((e) => e.kind === "watch_only")) {
    multipliers.push({
      name: "watch_only_load",
      value: WATCH_ONLY_LOAD,
      provenance: "COMPUTED",
      detail: "watch-only coverage, no containment possible → ×2",
    });
  }

  const product = multipliers.reduce((p, m) => p * m.value, 1);
  const baseMonthly = (policy.coverageCapUsd * baseRatePct) / 100;
  const monthlyPremiumUsd = round6(baseMonthly * product);
  const perBlockPremiumUsd = round6((baseMonthly * product) / BLOCKS_PER_MONTH);
  const formula =
    `premium = ${baseRatePct}%/mo × $${policy.coverageCapUsd} × ` +
    (multipliers.length > 0
      ? multipliers.map((m) => `${m.name}(×${m.value})`).join(" ")
      : "1") +
    ` = $${round6(baseMonthly)} × ${round6(product)} = $${monthlyPremiumUsd}/mo`;

  return {
    baseRatePct,
    multipliers,
    monthlyPremiumUsd,
    perBlockPremiumUsd,
    formula,
  };
}
