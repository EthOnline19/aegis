/**
 * ERC-8004 mapping constants — the approved v2 design values, pinned in
 * TypeScript AND in `contracts/test/Erc8004Integration.t.sol` (the two
 * must never drift; the forge suite fails if the Solidity pins change).
 *
 * Severity ordering is invariant across all three published signals
 * (validation score, reputation value, internal pricing load):
 * fraud < claim-loss < attempt.
 */
import type { VerdictOutcome } from "./types.ts";

/** tag1 on every feedback entry BULWARK posts (indexed on-chain). */
export const TAG1 = "bulwark-verdict" as const;

/** valueDecimals for every feedback entry (int128, |value| ≤ 1e38). */
export const VALUE_DECIMALS = 2 as const;

/** Validation score for a COVERED verdict (breached, but containment worked). */
export const SCORE_COVERED = 25 as const;
/** Validation score for ATTEMPTED (defenses held, no loss). */
export const SCORE_ATTEMPTED = 75 as const;
/** Validation score for DENIED_OWNER_ORIGIN (owner-signed breach). */
export const SCORE_DENIED_OWNER_ORIGIN = 0 as const;

/** Reputation value for COVERED (−25.00 — recoverable claim scar). */
export const VALUE_COVERED = -2500n as const;
/** Reputation value for ATTEMPTED (+5.00 — protection held). */
export const VALUE_ATTEMPTED = 500n as const;
/** Reputation value for DENIED_OWNER_ORIGIN (−100.00 — the fraud floor). */
export const VALUE_DENIED_OWNER_ORIGIN = -10_000n as const;

/** tag2 per outcome (indexed consumer filter granularity). */
export const TAG2_BY_OUTCOME = {
  COVERED: "covered",
  DENIED_OWNER_ORIGIN: "denied-owner-origin",
  ATTEMPTED: "attempted",
} as const satisfies Record<string, string>;

/** Validation score per outcome. */
export const SCORE_BY_OUTCOME: Record<VerdictOutcome, number> = {
  COVERED: SCORE_COVERED,
  DENIED_OWNER_ORIGIN: SCORE_DENIED_OWNER_ORIGIN,
  ATTEMPTED: SCORE_ATTEMPTED,
};

/** Reputation int128 value per outcome. */
export const VALUE_BY_OUTCOME: Record<VerdictOutcome, bigint> = {
  COVERED: VALUE_COVERED,
  DENIED_OWNER_ORIGIN: VALUE_DENIED_OWNER_ORIGIN,
  ATTEMPTED: VALUE_ATTEMPTED,
};

/**
 * Machine link back to the VerdictContract ledger (design §3).
 * `endpoint = bulwark://verdicts/<digest>` — cross-checkable against
 * VerdictContract's event ledger, the tamper-evident source of truth.
 */
export function verdictEndpoint(digest: `0x${string}`): `bulwark://verdicts/${string}` {
  return `bulwark://verdicts/${digest}`;
}

/**
 * `requestURI` for a validation request — anyone can cross-check the
 * request against the VerdictContract ledger via the public API.
 */
export function verdictRequestUri(digest: `0x${string}`): `https://api.bulwark.eth/v1/verdicts/${string}` {
  return `https://api.bulwark.eth/v1/verdicts/${digest}`;
}

/**
 * Map a raw on-chain `outcome` byte (BulwarkTypes.Outcome) to the design's
 * VerdictOutcome. NONE (0) and DISMISSED (4) have NO posting — the
 * orchestrator fails closed: unknown/absent outcomes post nothing.
 */
export function outcomeFromByte(outcome: number): VerdictOutcome | undefined {
  switch (outcome) {
    case 1: // BulwarkTypes.Outcome.COVERED
      return "COVERED";
    case 2: // BulwarkTypes.Outcome.DENIED_OWNER_ORIGIN
      return "DENIED_OWNER_ORIGIN";
    case 3: // BulwarkTypes.Outcome.ATTEMPTED_BREACH
      return "ATTEMPTED";
    default:
      return undefined; // NONE, DISMISSED, or anything unknown → no post
  }
}
