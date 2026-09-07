/**
 * BULWARK Watcher & Verdict Engine — the sealed referee's deterministic core.
 *
 * Design law (plan §9): the AI narrates, the code decides. Every tier,
 * outcome, and payout below is plain arithmetic on VERIFIED facts. An LLM
 * may draft the human-readable `detail` lines; nothing it writes can move
 * a verdict. The same logic re-runs on-chain (GuardAccount._classify) and
 * in dispute re-execution — same inputs, same verdict, always.
 */

import {
  Alibi,
  Outcome,
  Provenance,
  Tier,
  computePayout,
  curfewActive,
  effectiveLimit,
  isAllowlisted,
} from "./types.ts";
import type {
  BehavioralFacts,
  Policy,
  Reason,
  Transaction,
  Verdict,
} from "./types.ts";

/** Score thresholds — published, deterministic, no ML. */
export const SUSPICION_THRESHOLD = 3;

/**
 * The full forensic check on a transaction (hold-window path).
 * Layer 1 mirrors GuardAccount._classify (policy conformance).
 * Layer 2 adds behavioral anomaly scoring (the Watcher's own domain).
 * Returns RELEASE for clean, FREEZE for suspicious — fail-safe bias.
 */
export function judgeHold(policy: Policy, tx: Transaction, facts: BehavioralFacts): Verdict {
  const reasons: Reason[] = [];
  let score = 0;

  // ---- Layer 1: policy conformance (same rules as on-chain). ----
  const limit = effectiveLimit(policy, tx.to);
  if (tx.amount > limit) {
    reasons.push({
      tag: "AMOUNT_ABOVE_PER_TX",
      provenance: Provenance.COMPUTED,
      detail: `amount ${tx.amount.toString()} exceeds per-tx cap ${limit.toString()}`,
    });
    score += 2;
  }

  const allowlisted = isAllowlisted(policy, tx.to);
  if (!allowlisted) {
    reasons.push({
      tag: "NEW_RECIPIENT",
      provenance: Provenance.VERIFIED,
      detail: "recipient not on policy allowlist",
    });
    score += 1;
  }

  if (curfewActive(policy, tx.blockTimestamp)) {
    reasons.push({
      tag: "CURFEW_HOUR",
      provenance: Provenance.COMPUTED,
      detail: "transfer initiated during curfew hours",
    });
    score += 1;
  }

  // ---- Layer 2: behavioral anomalies (the Watcher's soft signals). ----
  if (facts.recipientFirstSeen === null) {
    reasons.push({
      tag: "RECIPIENT_BRAND_NEW",
      provenance: Provenance.VERIFIED,
      detail: "recipient wallet has no prior history",
    });
    score += 1;
  } else if (tx.blockTimestamp - facts.recipientFirstSeen < 7 * 86_400) {
    reasons.push({
      tag: "RECIPIENT_VERY_YOUNG",
      provenance: Provenance.VERIFIED,
      detail: "recipient wallet younger than 7 days",
    });
    score += 1;
  }

  if (facts.recipientOnBlocklistStrikes > 0) {
    reasons.push({
      tag: "BLOCKLIST_STRIKES",
      provenance: Provenance.VERIFIED,
      detail: `destination carries ${facts.recipientOnBlocklistStrikes} strike(s) on the shared blocklist`,
    });
    score += facts.recipientOnBlocklistStrikes >= 3 ? 3 : 1;
  }

  if (facts.knownDrainerCalldata) {
    reasons.push({
      tag: "DRAINER_SIGNATURE",
      provenance: Provenance.VERIFIED,
      detail: "calldata matches known drainer pattern",
    });
    score += 3;
  }

  // Amount deviation vs own history (σ-based, deterministic).
  const amountSigma = sigmaDeviation(tx.amount, facts.amountHistory);
  if (amountSigma !== null && amountSigma > 3) {
    reasons.push({
      tag: "AMOUNT_ANOMALY",
      provenance: Provenance.COMPUTED,
      detail: `amount is ${amountSigma.toFixed(1)}σ above this agent's historical mean`,
    });
    score += 1;
  }

  // Time-of-day novelty vs own history.
  const hour = Math.floor((tx.blockTimestamp % 86_400) / 3600);
  if (facts.hourOfDayHistory.length > 0 && !facts.hourOfDayHistory.includes(hour)) {
    reasons.push({
      tag: "UNUSUAL_HOUR",
      provenance: Provenance.COMPUTED,
      detail: `hour ${hour}:00 UTC is outside this agent's activity pattern`,
    });
    score += 1;
  }

  // ---- Layer 3: the alibi check (owner-signed → never release silently). ----
  if (tx.instruction?.ownerSigned === true && !allowlisted) {
    reasons.push({
      tag: "OWNER_SIGNED_NOVEL_DESTINATION",
      provenance: Provenance.VERIFIED,
      detail: "instruction is owner-signed but destination is novel — surface to owner",
    });
    score += 1; // Case 6 pattern: policy recently edited + full-balance transfer
  }

  const suspicious = score >= SUSPICION_THRESHOLD;
  return {
    tier: suspicious ? Tier.ELEVATED : Tier.ROUTINE,
    outcome: suspicious ? Outcome.ATTEMPTED_BREACH : Outcome.NONE,
    alibi: tx.instruction
      ? tx.instruction.ownerSigned
        ? Alibi.OWNER_SIGNED
        : Alibi.EXTERNAL
      : Alibi.UNKNOWN,
    payoutAmount: 0n,
    lossAmount: 0n,
    reasons,
    holdAction: suspicious ? "FREEZE" : "RELEASE",
  };
}

/**
 * The breach adjudication (post-execution path): the attack succeeded,
 * funds left. Determines COVERED vs DENIED_OWNER_ORIGIN and the payout.
 * This is the parametric heart: a covered event is a mathematical fact.
 */
export function judgeBreach(policy: Policy, tx: Transaction, facts: BehavioralFacts): Verdict {
  const reasons: Reason[] = [];

  // The alibi check (plan §10): was the breaching instruction owner-signed?
  let alibi: Alibi = Alibi.UNKNOWN;
  if (tx.instruction) {
    alibi = tx.instruction.ownerSigned ? Alibi.OWNER_SIGNED : Alibi.EXTERNAL;
  } else if (policy.sdkInstalled) {
    // SDK claimed but no chain entry for this tx — the claim cannot be verified.
    reasons.push({
      tag: "ALIBI_DATA_MISSING",
      provenance: Provenance.VERIFIED,
      detail: "SDK installed but no instruction record for this transaction",
    });
  } else {
    reasons.push({
      tag: "WATCH_ONLY_NO_ALIBI",
      provenance: Provenance.VERIFIED,
      detail: "no SDK installed — instruction provenance unavailable",
    });
  }

  // Policy violation is the covered-event definition (parametric trigger).
  const violated: boolean =
    tx.amount > effectiveLimit(policy, tx.to) ||
    !isAllowlisted(policy, tx.to) ||
    curfewActive(policy, tx.blockTimestamp) ||
    facts.knownDrainerCalldata ||
    facts.recipientOnBlocklistStrikes >= 3;

  if (violated) {
    reasons.push({
      tag: "POLICY_VIOLATION_CONFIRMED",
      provenance: Provenance.COMPUTED,
      detail: "breach breaks a machine-checkable policy rule",
    });
  }

  // Case 6: owner-authorized → DENIED. The act of ordering is confessing.
  if (alibi === Alibi.OWNER_SIGNED) {
    reasons.push({
      tag: "OWNER_ORIGIN",
      provenance: Provenance.VERIFIED,
      detail: "breaching instruction was signed by the owner's session key",
    });
    return {
      tier: Tier.VIOLATION,
      outcome: Outcome.DENIED_OWNER_ORIGIN,
      alibi,
      payoutAmount: 0n,
      lossAmount: tx.amount,
      reasons,
      holdAction: "NONE",
    };
  }

  // No verifiable external provenance and no SDK → capped-at-25% territory
  // (plan §21). v1 demo path: require EXTERNAL for full coverage.
  if (alibi !== Alibi.EXTERNAL) {
    reasons.push({
      tag: "PROVENANCE_UNVERIFIABLE",
      provenance: Provenance.VERIFIED,
      detail: "claim lacks instruction provenance — capped payout tier",
    });
    const capped = computePayout(tx.amount, policy.deductibleBps, policy.coverageCap) / 4n;
    return {
      tier: Tier.VIOLATION,
      outcome: Outcome.COVERED,
      alibi,
      payoutAmount: capped,
      lossAmount: tx.amount,
      reasons,
      holdAction: "NONE",
    };
  }

  // External instruction + policy breach → COVERED EVENT (Case 5).
  reasons.push({
    tag: "EXTERNAL_INJECTION",
    provenance: Provenance.VERIFIED,
    detail: "instruction originated outside the owner session — covered event",
  });
  return {
    tier: Tier.VIOLATION,
    outcome: Outcome.COVERED,
    alibi,
    payoutAmount: computePayout(tx.amount, policy.deductibleBps, policy.coverageCap),
    lossAmount: tx.amount,
    reasons,
    holdAction: "NONE",
  };
}

/** Deterministic σ-deviation of `amount` vs history; null if insufficient data. */
export function sigmaDeviation(amount: bigint, history: readonly bigint[]): number | null {
  if (history.length < 4) return null;
  let sum = 0n;
  for (const h of history) sum += h;
  const mean = sum / BigInt(history.length);
  let sq = 0n;
  for (const h of history) {
    const d = h - mean;
    sq += d * d;
  }
  const variance = sq / BigInt(history.length);
  const std = sqrtApprox(variance);
  if (std === 0n) return null;
  const dev = amount > mean ? amount - mean : mean - amount;
  return Number((dev * 1000n) / std) / 1000;
}

/** Integer square root (Newton's method) — deterministic, no float drift. */
export function sqrtApprox(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
