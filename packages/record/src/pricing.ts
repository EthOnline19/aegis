/**
 * Pricing wiring — the real @bulwark/pricing engine (shared contract, §12).
 *
 *   computePremium(
 *     policy: { coverageCapUsd: number; baseRatePct?: number },
 *     events: PricingEvent[],
 *   ) => Premium
 *
 * The sibling package landed in the workspace; we re-export its surface
 * and add the two helpers the résumé needs: the DRIVING line's multiplier
 * figure and the §12 formula invariant used by the wiring test.
 */

import { computePremium as engineComputePremium } from "@bulwark/pricing";
import type {
  PricingEvent,
  PricingPolicy,
  PricingMultiplier,
  Premium,
} from "@bulwark/pricing";

export type { PricingEvent, PricingPolicy, PricingMultiplier, Premium };

export { computePremium } from "@bulwark/pricing";

/** The @bulwark/pricing module surface (kept for callers that load dynamically). */
export interface PricingEngine {
  computePremium(policy: PricingPolicy, events: readonly PricingEvent[]): Premium;
}

/** The real engine, statically imported — no stub, no fallback. */
export const pricingEngine: PricingEngine = {
  computePremium: (policy, events) => engineComputePremium(policy, [...events]),
};

/** Product of all multipliers — the DRIVING line's "premium 0.72x" figure. */
export function multiplierOf(premium: Premium): number {
  return premium.multipliers.reduce((acc, m) => acc * m.value, 1);
}

/**
 * The §12 invariant: monthly premium = base_rate × coverage_cap ×
 * product(multipliers). Used as the wiring test's contract check — whatever
 * the engine returns must be consistent with its own published formula.
 */
export function expectedMonthlyUsd(premium: Premium, coverageCapUsd: number): number {
  return (coverageCapUsd * premium.baseRatePct * multiplierOf(premium)) / 100;
}
