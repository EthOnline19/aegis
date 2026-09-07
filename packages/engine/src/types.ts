/**
 * BULWARK shared types — the TypeScript mirror of contracts/src/BulwarkTypes.sol.
 *
 * "The AI narrates, the code decides": every structure here is deterministic.
 * The LLM may produce `detail` narrative text; it can never influence a tier,
 * an outcome, or a payout amount.
 */

/** Reason provenance — nothing is ever INFERRED. */
export enum Provenance {
  VERIFIED = 0, // read from signed, public data
  COMPUTED = 1, // this formula, published
}

/** The three lanes (numeric values mirror the Solidity classifier). */
export enum Tier {
  ROUTINE = 0,
  ELEVATED = 1,
  VIOLATION = 2,
}

/** Alibi outcome: was the breaching instruction owner-signed? */
export enum Alibi {
  UNKNOWN = 0,
  EXTERNAL = 1, // outside the owner session → coverable
  OWNER_SIGNED = 2, // the owner ordered it → DENY
}

/** What the verdict directs the on-chain world to do. */
export enum Outcome {
  NONE = 0,
  COVERED = 1, // parametric trigger met → pool payout
  DENIED_OWNER_ORIGIN = 2, // alibi proves owner fraud → claim scar
  ATTEMPTED_BREACH = 3, // blocked/held attack → pricing signal
  DISMISSED = 4, // overturned by re-run or arbitration (no fault)
}

/** Per-recipient sub-cap (Case 1: payroll contract gets $400). */
export interface RecipientCap {
  readonly recipient: `0x${string}`;
  readonly cap: bigint; // USDC base units (6 decimals)
}

/** The Policy — "the rules of normal". Mirrors the on-chain struct. */
export interface Policy {
  readonly version: number;
  readonly agent: `0x${string}`;
  readonly owner: `0x${string}`;
  readonly coverageCap: bigint;
  readonly deductibleBps: number;
  readonly perTxLimit: bigint;
  readonly dailyLimit: bigint;
  readonly velocityLimit: number;
  readonly allowlist: readonly RecipientCap[];
  readonly curfewStartMinute: number; // 1440 = none
  readonly curfewEndMinute: number; // 1440 = none
  readonly holdWindowSec: number;
  readonly sdkInstalled: boolean;
}

/** A proposed or executed transfer the engine judges. */
export interface Transaction {
  readonly to: `0x${string}`;
  readonly amount: bigint; // USDC base units
  readonly txHash: `0x${string}`;
  readonly blockTimestamp: number;
  readonly calldata: `0x${string}`;
  /** Instruction-chain entry that produced this tx, if the SDK was installed. */
  readonly instruction?: InstructionRecord;
}

/** One link in the instruction hash-chain (the alibi data source). */
export interface InstructionRecord {
  readonly digest: `0x${string}`; // keccak256(instruction text)
  readonly origin: "owner-console" | "job" | "web" | "tool";
  readonly ownerSigned: boolean; // true iff signed with the owner session key
  readonly timestamp: number;
  readonly teeCosigned: boolean;
  readonly prev: `0x${string}`; // previous chain head (0x0 for genesis)
}

/** A single reason line inside a verdict — always labeled. */
export interface Reason {
  readonly tag: string; // e.g. "AMOUNT_ABOVE_PER_TX"
  readonly provenance: Provenance;
  readonly detail: string; // human-readable narrative (LLM may draft; never decides)
}

/** Behavioral facts the Watcher gathered (all VERIFIED sources). */
export interface BehavioralFacts {
  readonly recipientFirstSeen: number | null; // block timestamp or null if brand-new
  readonly recipientOnBlocklistStrikes: number;
  readonly knownDrainerCalldata: boolean; // calldata matches known drainer signature
  readonly hourOfDayHistory: readonly number[]; // agent's historical active hours (UTC)
  readonly amountHistory: readonly bigint[]; // agent's historical tx amounts
}

/** The full verdict the engine emits. */
export interface Verdict {
  readonly tier: Tier;
  readonly outcome: Outcome;
  readonly alibi: Alibi;
  readonly payoutAmount: bigint; // 0 unless COVERED
  readonly lossAmount: bigint;
  readonly reasons: readonly Reason[];
  readonly holdAction: "RELEASE" | "FREEZE" | "NONE"; // for pending holds
}

export const USDC_DECIMALS = 6;

export const NO_CURFEW = 1440;

/**
 * Payout formula (deterministic, public): loss × (1 − deductibleBps/10⁴),
 * floored at the coverage cap. Three call sites (engine, SDK preview, tests)
 * need lockstep behavior with the Solidity `PayoutExceedsLoss` rule.
 */
export function computePayout(loss: bigint, deductibleBps: number, coverageCap: bigint): bigint {
  const afterDeductible = (loss * BigInt(10_000 - deductibleBps)) / 10_000n;
  return afterDeductible > coverageCap ? coverageCap : afterDeductible;
}

/** Policy conformance: the effective per-tx cap for `to` (sub-cap or global). */
export function effectiveLimit(policy: Policy, to: `0x${string}`): bigint {
  const entry = policy.allowlist.find((c) => c.recipient.toLowerCase() === to.toLowerCase());
  return entry ? entry.cap : policy.perTxLimit;
}

/** Allowlist membership — used by the classifier and the demo surfaces. */
export function isAllowlisted(policy: Policy, to: `0x${string}`): boolean {
  return policy.allowlist.some((c) => c.recipient.toLowerCase() === to.toLowerCase());
}

/** UTC minute-of-day curfew check (handles overnight wrap). */
export function curfewActive(policy: Policy, timestamp: number): boolean {
  if (policy.curfewStartMinute === NO_CURFEW || policy.curfewEndMinute === NO_CURFEW) return false;
  const minuteOfDay = Math.floor((timestamp % 86_400) / 60);
  const { curfewStartMinute: s, curfewEndMinute: e } = policy;
  if (s === e) return true;
  if (s < e) return minuteOfDay >= s && minuteOfDay < e;
  return minuteOfDay >= s || minuteOfDay < e; // overnight wrap (22:00 → 05:00)
}

/**
 * The on-chain Policy shape — the literal struct from
 * contracts/src/BulwarkTypes.sol (field names byte-identical, curfew
 * fields carry their Solidity names). This type + converter are the SINGLE
 * translation point between the TS Policy and the Solidity Policy; no
 * package may hand-duplicate either shape again (review H5).
 */
export interface OnChainPolicy {
  readonly version: number;
  readonly agent: `0x${string}`;
  readonly owner: `0x${string}`;
  readonly coverageCap: bigint;
  readonly deductibleBps: number;
  readonly perTxLimit: bigint;
  readonly dailyLimit: bigint;
  readonly velocityLimit: number;
  readonly allowlist: readonly RecipientCap[];
  readonly curfewStart: number; // Solidity name; TS Policy: curfewStartMinute
  readonly curfewEnd: number; // Solidity name; TS Policy: curfewEndMinute
  readonly holdWindowSec: number;
  readonly sdkInstalled: boolean;
}

/** TS Policy → on-chain Policy: the one documented rename, applied once. */
export function toOnChainPolicy(policy: Policy): OnChainPolicy {
  return {
    version: policy.version,
    agent: policy.agent,
    owner: policy.owner,
    coverageCap: policy.coverageCap,
    deductibleBps: policy.deductibleBps,
    perTxLimit: policy.perTxLimit,
    dailyLimit: policy.dailyLimit,
    velocityLimit: policy.velocityLimit,
    allowlist: policy.allowlist,
    curfewStart: policy.curfewStartMinute,
    curfewEnd: policy.curfewEndMinute,
    holdWindowSec: policy.holdWindowSec,
    sdkInstalled: policy.sdkInstalled,
  };
}
