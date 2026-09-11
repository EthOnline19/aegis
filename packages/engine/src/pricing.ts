/**
 * REPAYD Pricing Engine v1 — telematics for machines.
 *
 * The deterministic, public formula (plan §12). Every number is labeled
 * COMPUTED; every input comes from the Risk Subgraph (VERIFIED events).
 *
 *   premium = base_rate × coverage_cap × product(multipliers)
 *   charged per block the agent is active with funds at risk.
 */

import { Provenance } from "./types.ts";
import type { Reason } from "./types.ts";

export interface DrivingRecord {
  readonly cleanStreakDays: number;
  /** Behavioral variance vs own history, 0..1 (from anomaly scoring). */
  readonly anomalyLoad: number; // 0.0 – 1.0 → +0%…+40%
  /** Timestamps of attempted breaches in the last 30 days. */
  readonly attemptedBreaches: readonly number[];
  /** Paid claims in the last 6 months, and total lifetime. */
  readonly recentClaims: readonly number[];
  readonly lifetimeClaims: number;
  readonly worldIdVerified: boolean; // KYA: a unique human backs the agent
  readonly sdkInstalled: boolean;
  readonly watchOnly: boolean; // no containment possible → moral hazard
  readonly now: number;
}

export interface Quote {
  readonly multiplier: number; // product of all multipliers
  readonly monthlyPremium: bigint; // USDC base units (6dp), base 2%/mo of cap
  readonly reasons: readonly Reason[];
}

export const BASE_RATE_MONTHLY = 0.02; // 2.0% of coverage per month
export const MAX_STREAK_DISCOUNT = 0.6; // −60% at 180 clean days
export const STREAK_DAYS_MAX = 180;
export const ANOMALY_LOAD_MAX = 0.4; // +40%
export const ATTEMPT_LOAD = 0.15; // +15% for 30 days after an attempted breach
export const CLAIM_LOAD_FIRST = 3; // ×3 for 6 months after a paid claim
export const CLAIM_LOAD_REPEAT = 5; // ×5 for 2+ lifetime claims
export const KYA_DISCOUNT = 0.2; // −20% World-ID verified
export const SDK_DISCOUNT = 0.1; // −10% alibi data available
export const WATCH_ONLY_LOAD = 2; // ×2 no containment
export const THIRTY_DAYS = 30 * 86_400;
export const SIX_MONTHS = 182 * 86_400;

/**
 * Compute the premium multiplier and monthly-equivalent premium.
 * Deterministic: same driving record, same quote, forever.
 */
export function quote(record: DrivingRecord, coverageCap: bigint): Quote {
  const reasons: Reason[] = [];
  let multiplier = 1;

  // Streak discount: linear to −60% over 180 clean days.
  const streakFrac = Math.min(record.cleanStreakDays / STREAK_DAYS_MAX, 1);
  const streakDiscount = MAX_STREAK_DISCOUNT * streakFrac;
  if (streakDiscount > 0) {
    multiplier *= 1 - streakDiscount;
    reasons.push({
      tag: "STREAK_DISCOUNT",
      provenance: Provenance.COMPUTED,
      detail: `${record.cleanStreakDays} clean days → −${(streakDiscount * 100).toFixed(1)}%`,
    });
  }

  // Anomaly load: behavioral variance vs own history, +0–40%.
  const anomaly = Math.min(Math.max(record.anomalyLoad, 0), 1) * ANOMALY_LOAD_MAX;
  if (anomaly > 0) {
    multiplier *= 1 + anomaly;
    reasons.push({
      tag: "ANOMALY_LOAD",
      provenance: Provenance.COMPUTED,
      detail: `behavioral variance → +${(anomaly * 100).toFixed(1)}%`,
    });
  }

  // Attempted breach load: +15% for 30 days after each near-miss.
  const recentAttempt = record.attemptedBreaches.some((t) => record.now - t < THIRTY_DAYS);
  if (recentAttempt) {
    multiplier *= 1 + ATTEMPT_LOAD;
    reasons.push({
      tag: "ATTEMPT_LOAD",
      provenance: Provenance.COMPUTED,
      detail: `attempted breach within 30 days → +${(ATTEMPT_LOAD * 100).toFixed(0)}%`,
    });
  }

  // Claim load: ×3 for 6 months after a paid claim; ×5 for 2+ lifetime.
  const recentClaim = record.recentClaims.some((t) => record.now - t < SIX_MONTHS);
  if (recentClaim || record.lifetimeClaims > 0) {
    const load = record.lifetimeClaims >= 2 ? CLAIM_LOAD_REPEAT : CLAIM_LOAD_FIRST;
    // Only apply while recent (the scar is the record; the load is the term).
    if (recentClaim) {
      multiplier *= load;
      reasons.push({
        tag: "CLAIM_LOAD",
        provenance: Provenance.COMPUTED,
        detail: `paid claim within 6 months → ×${load}`,
      });
    }
  }

  if (record.worldIdVerified) {
    multiplier *= 1 - KYA_DISCOUNT;
    reasons.push({
      tag: "KYA_DISCOUNT",
      provenance: Provenance.VERIFIED,
      detail: "backing human is World-ID verified → −20%",
    });
  }

  if (record.sdkInstalled) {
    multiplier *= 1 - SDK_DISCOUNT;
    reasons.push({
      tag: "SDK_DISCOUNT",
      provenance: Provenance.VERIFIED,
      detail: "alibi SDK installed → −10%",
    });
  }

  if (record.watchOnly) {
    multiplier *= WATCH_ONLY_LOAD;
    reasons.push({
      tag: "WATCH_ONLY_LOAD",
      provenance: Provenance.COMPUTED,
      detail: "no containment (watch-only) → ×2 moral hazard load",
    });
  }

  const monthly = BigInt(Math.round(Number(coverageCap) * BASE_RATE_MONTHLY * multiplier));
  return { multiplier, monthlyPremium: monthly, reasons };
}
