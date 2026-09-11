/**
 * Pricing wiring — @bulwark/pricing shared contract (track contract, §12).
 *
 *   computePremium(
 *     policy: { coverageCapUsd: number; baseRatePct?: number },
 *     events: PricingEvent[],
 *   ) => PremiumResult
 *
 * The sibling package may still be in flight; we code against this exact
 * signature and resolve the real implementation at call time. There is NO
 * local fallback: if @bulwark/pricing is not resolvable, loadPricingEngine
 * throws and the caller reports the blocker.
 */

/** §12 pricing signal kinds (from the Risk Subgraph event stream). */
export type PricingEventKind =
  | "clean_day"
  | "attempted_breach"
  | "covered_claim"
  | "denied_claim"
  | "recovered"
  | "mitigation"
  | "watch_only"
  | "kya_verified"
  | "sdk_installed";

export interface PricingEvent {
  readonly kind: PricingEventKind;
  /** ms epoch. */
  readonly at: number;
  readonly amountUsd?: number;
}

export interface PricingPolicyInput {
  readonly coverageCapUsd: number;
  readonly baseRatePct?: number;
}

export interface PricingMultiplier {
  readonly name: string;
  readonly value: number;
  readonly provenance: "VERIFIED" | "COMPUTED";
  readonly detail: string;
}

export interface PremiumResult {
  readonly baseRatePct: number;
  readonly multipliers: readonly PricingMultiplier[];
  readonly monthlyPremiumUsd: number;
  readonly perBlockPremiumUsd?: number;
  readonly formula: string;
}

/** The @bulwark/pricing module surface, per the shared contract. */
export interface PricingEngine {
  computePremium(policy: PricingPolicyInput, events: readonly PricingEvent[]): PremiumResult;
}

/**
 * Resolve the real @bulwark/pricing at call time (never at import time —
 * no network, no resolution side effects on module load). Throws with the
 * blocker if the sibling package is not yet resolvable.
 *
 * @bulwark/pricing is in flight on this track; once it lands in the
 * workspace this import resolves and the directive below must be removed.
 */
export async function loadPricingEngine(): Promise<PricingEngine> {
  // @ts-expect-error — @bulwark/pricing not yet resolvable (sibling in flight).
  return (await import("@bulwark/pricing")) as PricingEngine;
}

/** Product of all multipliers — the DRIVING line's "premium 0.72x" figure. */
export function multiplierOf(premium: PremiumResult): number {
  return premium.multipliers.reduce((acc, m) => acc * m.value, 1);
}

/**
 * The §12 invariant: monthly premium = base_rate × coverage_cap ×
 * product(multipliers). Used as the wiring test's contract check — whatever
 * the engine returns must be consistent with its own published formula.
 */
export function expectedMonthlyUsd(premium: PremiumResult, coverageCapUsd: number): number {
  return (coverageCapUsd * premium.baseRatePct * multiplierOf(premium)) / 100;
}
