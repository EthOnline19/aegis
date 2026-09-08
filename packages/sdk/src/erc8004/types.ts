/**
 * ERC-8004 integration types (TS side of the approved v2 design).
 */

/**
 * The three outcomes that produce on-chain posts. `NONE` and `DISMISSED`
 * are deliberately absent — those verdicts are never posted (design §2/§3).
 */
export type VerdictOutcome = "COVERED" | "DENIED_OWNER_ORIGIN" | "ATTEMPTED";

/** Inputs identifying the accepted verdict an ERC-8004 record mirrors. */
export interface VerdictRef {
  /** GuardAccount the verdict concerns (= ERC-8004 binding anchor). */
  readonly guardAccount: `0x${string}`;
  /** The breached transaction (VerdictContract nullifier key). */
  readonly txHash: `0x${string}`;
  /** The accepted verdict digest (VerdictContract event). */
  readonly digest: `0x${string}`;
}

/** One reputation feedback entry as read back from the registry. */
export interface FeedbackEntry {
  readonly client: `0x${string}`;
  readonly feedbackIndex: bigint;
  /** int128 as returned by the registry (two's complement for negatives). */
  readonly value: bigint;
  readonly valueDecimals: number;
  readonly tag1: string;
  readonly tag2: string;
  readonly isRevoked: boolean;
}
