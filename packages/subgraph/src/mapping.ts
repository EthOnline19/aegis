// BULWARK Risk Subgraph — mappings.
// Every handler is a pure event→entity projection. No logic, no judgment:
// the subgraph is a read replica, not a referee.

import {
  Policy,
  RecipientCap,
  Classification,
  Hold,
  Verdict,
  Reason,
  BlocklistEntry,
  Report,
  PoolState,
  Payout,
  TrancheDeposit,
} from "../generated/schema";
import {
  PolicyUpdated,
  PolicyRevoked,
} from "../generated/PolicyRegistry/PolicyRegistry";
import {
  Classified,
  Held,
  Released,
  OwnerDecision,
  HoldLapsed,
} from "../generated/GuardAccount/GuardAccount";
import {
  VerdictAccepted,
  AttemptedBreachSignal,
} from "../generated/VerdictContract/VerdictContract";
import { Reported, Cleared } from "../generated/Blocklist/Blocklist";
import {
  Deposited,
  Payout as PayoutEvent,
  LossApplied,
  PremiumRecorded,
} from "../generated/MutualPool/MutualPool";
import { BigInt, Bytes } from "@graphprotocol/graph-ts";

// ------------------------------------------------------------------ //
//                        PolicyRegistry                              //
// ------------------------------------------------------------------ //

export function handlePolicyUpdated(event: PolicyUpdated): void {
  const agentId = event.params.agent.toHexString();
  let policy = Policy.load(agentId);
  if (policy === null) {
    policy = new Policy(agentId);
    policy.agent = event.params.agent;
    policy.createdAt = event.block.timestamp;
    policy.allowlist = [];
  }
  policy.version = event.params.version;
  policy.policyHash = event.params.policyHash;
  policy.updatedAt = event.block.timestamp;
  policy.revoked = false;
  policy.save();
}

export function handlePolicyRevoked(event: PolicyRevoked): void {
  const policy = Policy.load(event.params.agent.toHexString());
  if (policy !== null) {
    policy.revoked = true;
    policy.updatedAt = event.block.timestamp;
    policy.save();
  }
}

// ------------------------------------------------------------------ //
//                        GuardAccount                                //
// ------------------------------------------------------------------ //

export function handleClassified(event: Classified): void {
  const c = new Classification(event.transaction.hash.toHexString());
  c.policy = event.address.toHexString(); // the GuardAccount is the agent
  c.agent = event.address;
  c.tier = event.params.tier;
  c.tag = event.params.tag;
  c.to = event.params.to;
  c.amount = event.params.amount;
  c.blockTimestamp = event.block.timestamp;
  c.save();
}

export function handleHeld(event: Held): void {
  const h = new Hold(event.params.holdId.toString());
  const c = new Classification(event.transaction.hash.toHexString());
  c.policy = event.address.toHexString();
  c.agent = event.address;
  c.tier = 1; // elevated
  c.tag = Bytes.fromHexString("0x22b6faa0"); // NEW_RECIPIENT (simplified)
  c.to = event.params.to;
  c.amount = event.params.amount;
  c.blockTimestamp = event.block.timestamp;
  c.save();
  h.classification = c.id;
  h.agent = event.address;
  h.to = event.params.to;
  h.amount = event.params.amount;
  h.releaseAt = event.params.releaseAt;
  h.createdAt = event.block.timestamp;
  h.extendedTo = BigInt.fromI32(0);
  h.status = 0; // pending
  h.save();
}

export function handleReleased(event: Released): void {
  const h = Hold.load(event.params.holdId.toString());
  if (h !== null) {
    h.status = 1; // released
    h.resolvedAt = event.block.timestamp;
    h.resolvedBy = event.address;
    h.save();
  }
}

export function handleOwnerDecision(event: OwnerDecision): void {
  const h = Hold.load(event.params.holdId.toString());
  if (h !== null) {
    // decision: 0 approve, 1 freeze, 2 freeze+rotate; 0xFF watcher-frozen, 0xFE auto-frozen
    const d = event.params.decision;
    h.status = d === 0 ? 3 : 4; // owner-executed : cancelled
    h.resolvedAt = event.block.timestamp;
    h.resolvedBy = event.params.actor;
    h.save();
  }
}

export function handleHoldLapsed(event: HoldLapsed): void {
  const h = Hold.load(event.params.holdId.toString());
  if (h !== null) {
    h.extendedTo = event.params.extendedTo;
    h.save();
  }
}

// ------------------------------------------------------------------ //
//                       VerdictContract                              //
// ------------------------------------------------------------------ //

export function handleVerdictAccepted(event: VerdictAccepted): void {
  const v = new Verdict(event.params.digest.toHexString());
  const policyId = event.params.agent.toHexString();
  const policy = Policy.load(policyId);
  if (policy !== null) v.policy = policy.id;
  v.agent = event.params.agent;
  v.outcome = event.params.outcome;
  v.payoutAmount = event.params.payout;
  v.alibi = event.params.alibi;
  v.lossAmount = BigInt.fromI32(0); // loss recorded via reasons; on-chain events stay lean
  v.claimant = event.address;
  v.acceptedAt = event.block.timestamp;
  v.save();
}

export function handleAttemptedBreach(event: AttemptedBreachSignal): void {
  const v = new Verdict(event.params.txHash.toHexString());
  const policyRef = Policy.load(event.params.agent.toHexString());
  if (policyRef !== null) v.policy = policyRef.id;
  v.agent = event.params.agent;
  v.txHash = event.params.txHash;
  v.outcome = 3; // attempted breach
  v.alibi = 0;
  v.lossAmount = BigInt.fromI32(0);
  v.payoutAmount = BigInt.fromI32(0);
  v.claimant = event.params.agent;
  v.acceptedAt = event.block.timestamp;
  v.save();
}

// ------------------------------------------------------------------ //
//                          Blocklist                                 //
// ------------------------------------------------------------------ //

export function handleReported(event: Reported): void {
  const destId = event.params.destination.toHexString();
  let entry = BlocklistEntry.load(destId);
  if (entry === null) {
    entry = new BlocklistEntry(destId);
    entry.destination = event.params.destination;
    entry.strikes = 0;
  }
  entry.strikes = event.params.strikes;
  entry.flagged = event.params.strikes >= 3;
  entry.save();

  const report = new Report(
    event.transaction.hash.concatI32(event.logIndex.toI32()).toHexString(),
  );
  report.entry = entry.id;
  report.evidence = event.params.evidence;
  report.reporter = event.address;
  report.blockTimestamp = event.block.timestamp;
  report.save();
}

export function handleCleared(event: Cleared): void {
  const entry = BlocklistEntry.load(event.params.destination.toHexString());
  if (entry !== null) {
    entry.strikes = 0;
    entry.flagged = false;
    entry.save();
  }
}

// ------------------------------------------------------------------ //
//                         MutualPool                                 //
// ------------------------------------------------------------------ //

function loadPool(): PoolState {
  let pool = PoolState.load("pool");
  if (pool === null) {
    pool = new PoolState("pool");
    pool.juniorCapital = BigInt.fromI32(0);
    pool.seniorCapital = BigInt.fromI32(0);
    pool.premiumPool = BigInt.fromI32(0);
    pool.totalPayouts = BigInt.fromI32(0);
    pool.claimCount = 0;
  }
  return pool;
}

export function handleDeposited(event: Deposited): void {
  const pool = loadPool();
  if (event.params.tranche === 0) {
    pool.seniorCapital = pool.seniorCapital.plus(event.params.assets);
  } else {
    pool.juniorCapital = pool.juniorCapital.plus(event.params.assets);
  }
  pool.save();

  const d = new TrancheDeposit(event.transaction.hash.toHexString());
  d.depositor = event.params.depositor;
  d.tranche = event.params.tranche;
  d.assets = event.params.assets;
  d.shares = event.params.shares;
  d.blockTimestamp = event.block.timestamp;
  d.save();
}

export function handlePayout(event: PayoutEvent): void {
  const pool = loadPool();
  pool.totalPayouts = pool.totalPayouts.plus(event.params.amount);
  pool.claimCount += 1;
  pool.save();

  const p = new Payout(event.params.digest.toHexString());
  p.claimant = event.params.claimant;
  p.amount = event.params.amount;
  p.juniorLoss = BigInt.fromI32(0);
  p.seniorLoss = BigInt.fromI32(0);
  const verdict = Verdict.load(event.params.digest.toHexString());
  if (verdict !== null) p.verdict = verdict.id;
  p.blockTimestamp = event.block.timestamp;
  p.save();
}

export function handleLossApplied(event: LossApplied): void {
  const pool = loadPool();
  pool.juniorCapital = pool.juniorCapital.minus(event.params.juniorLoss);
  pool.seniorCapital = pool.seniorCapital.minus(event.params.seniorLoss);
  pool.save();
}

export function handlePremiumRecorded(event: PremiumRecorded): void {
  const pool = loadPool();
  pool.premiumPool = pool.premiumPool.plus(event.params.amount);
  pool.save();
}
