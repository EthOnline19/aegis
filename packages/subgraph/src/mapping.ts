// BULWARK Risk Subgraph — mappings.
// Every handler is a pure event→entity projection. No logic, no judgment:
// the subgraph is a read replica, not a referee.
//
// Derived updates required by the contract of this subgraph:
//   - Agent.streak++ on ExecutedRoutine (reset on attempt/strike events)
//   - Claim recorded on VerdictAccepted (covered/denied + payout)
//   - BlocklistEntry.strikes maintained from Reported/StrikeRecorded
//   - Hold lifecycle: Held → Released | Frozen (OwnerDecision/watch/auto)

import {
  Agent,
  Policy,
  RecipientCap,
  Transaction,
  Hold,
  Verdict,
  Claim,
  BlocklistEntry,
  Report,
  Transfer,
  PoolFlow,
  PoolState,
} from "../generated/schema";
import { PolicyUpdated, PolicyRevoked } from "../generated/PolicyRegistry/PolicyRegistry";
import { PolicyRegistry } from "../generated/PolicyRegistry/PolicyRegistry";
import {
  Classified,
  Held,
  Released,
  OwnerDecision,
  ExecutedRoutine,
  ViolationBlocked,
  AttemptedBreach,
  AuthorityRevoked,
  AgentKeyRotated,
  HoldLapsed,
  Withdrawn,
  VerdictContractSet as GuardVerdictContractSet,
  Received,
} from "../generated/GuardAccount/GuardAccount";
import {
  VerdictAccepted,
  HoldVerdictRouted,
  AttemptedBreachSignal,
  Reopened,
  Escalated,
  ArbitrationConcluded,
  StrikeRecorded,
  WatcherSet,
  PoolSet,
  ArbiterSet,
} from "../generated/VerdictContract/VerdictContract";
import { Reported, Cleared, AdminChanged, ReporterSet } from "../generated/Blocklist/Blocklist";
import {
  Deposited,
  Redeemed,
  Payout as PayoutEvent,
  PremiumRecorded,
  LossApplied,
  ReinsuranceHooked,
  VerdictContractSet as PoolVerdictContractSet,
} from "../generated/MutualPool/MutualPool";
import { Transfer as UsdcTransfer, Approval } from "../generated/Usdc/Usdc";
import { BigInt, BigDecimal } from "@graphprotocol/graph-ts";

// BulwarkTypes.Outcome
const OUTCOME_NONE = 0;
const OUTCOME_COVERED = 1;
const OUTCOME_DENIED_OWNER_ORIGIN = 2;
const OUTCOME_ATTEMPTED_BREACH = 3;
const OUTCOME_DISMISSED = 4;

// Hold.status
const HOLD_PENDING = 0;
const HOLD_RELEASED = 1;
const HOLD_FROZEN = 2;
const HOLD_OWNER_APPROVED = 3;
const HOLD_OWNER_FROZEN = 4;
const HOLD_OWNER_FROZEN_ROTATED = 5;
const HOLD_WATCHER_FROZEN = 6; // OwnerDecision sentinel 0xFF
const HOLD_AUTO_FROZEN = 7; // OwnerDecision sentinel 0xFE

// GuardAccount Decision (owner path)
const DECISION_APPROVE = 0;
const DECISION_FREEZE = 1;
const DECISION_FREEZE_ROTATE = 2;

function eventId(event: ethereum.Event): string {
  return event.transaction.hash.concatI32(event.logIndex.toI32()).toHexString();
}

function zeroBigInt(): BigInt {
  return BigInt.fromI32(0);
}

function loadAgent(address: Bytes): Agent {
  const id = address.toHexString();
  let agent = Agent.load(id);
  if (agent === null) {
    agent = new Agent(id);
    agent.guardAddress = address;
    agent.streak = zeroBigInt();
    agent.premiumMultiplier = BigDecimal.fromString("1");
    agent.totalRoutineTx = zeroBigInt();
    agent.totalAttempts = zeroBigInt();
    agent.save();
  }
  return agent;
}

function noteIncident(agent: Agent, timestamp: BigInt): void {
  // A blocked/held attempt or a strike resets the clean streak (§12).
  agent.streak = zeroBigInt();
  agent.lastIncidentAt = timestamp;
  agent.totalAttempts = agent.totalAttempts.plus(BigInt.fromI32(1));
  agent.save();
}

// ------------------------------------------------------------------ //
//                        PolicyRegistry                              //
// ------------------------------------------------------------------ //

export function handlePolicyUpdated(event: PolicyUpdated): void {
  const agent = loadAgent(event.params.agent);

  let policy = Policy.load(agent.id);
  if (policy === null) {
    policy = new Policy(agent.id);
    policy.createdAt = event.block.timestamp;
  }
  policy.agent = agent.id;
  policy.version = BigInt.fromUInt32(event.params.version);
  policy.policyHash = event.params.policyHash;
  policy.revoked = false;
  policy.revokedAt = null;
  policy.updatedAt = event.block.timestamp;

  // The event carries only the hash; pull the live policy fields via
  // getPolicyView (flat, cheap) so the résumé can show cap/perTx/daily/
  // velocity/allowlist without another indexer.
  const reg = PolicyRegistry.bind(event.address);
  const view = reg.try_getPolicyView(event.params.agent);
  if (!view.reverted) {
    const v = view.value;
    policy.owner = v.owner;
    policy.cap = v.coverageCap;
    policy.perTx = v.perTxLimit;
    policy.daily = v.dailyLimit;
    policy.velocity = BigInt.fromUInt32(v.velocityLimit);
    policy.deductibleBps = BigInt.fromUInt32(v.deductibleBps);
    policy.curfewStart = BigInt.fromUInt32(v.curfewStart);
    policy.curfewEnd = BigInt.fromUInt32(v.curfewEnd);
    policy.holdWindowSec = BigInt.fromUInt32(v.holdWindowSec);
    policy.sdkInstalled = v.sdkInstalled;

    // Rebuild the allowlist (id: <policyId>-<recipient>).
    for (let i = 0; i < v.recipients.length; i++) {
      const rcId = policy.id.concat("-").concat(v.recipients[i].toHexString());
      let rc = RecipientCap.load(rcId);
      if (rc === null) {
        rc = new RecipientCap(rcId);
        rc.policy = policy.id;
        rc.recipient = v.recipients[i];
      }
      rc.cap = v.caps[i];
      rc.save();
    }
  }
  policy.save();
}

export function handlePolicyRevoked(event: PolicyRevoked): void {
  const policy = Policy.load(event.params.agent.toHexString());
  if (policy !== null) {
    policy.revoked = true;
    policy.revokedAt = event.block.timestamp;
    policy.updatedAt = event.block.timestamp;
    policy.save();
  }
}

// ------------------------------------------------------------------ //
//                        GuardAccount                                //
// ------------------------------------------------------------------ //

export function handleExecutedRoutine(event: ExecutedRoutine): void {
  const agent = loadAgent(event.address);
  agent.streak = agent.streak.plus(BigInt.fromI32(1));
  agent.totalRoutineTx = agent.totalRoutineTx.plus(BigInt.fromI32(1));
  agent.lastRoutineAt = event.block.timestamp;
  agent.save();

  const t = new Transaction(eventId(event));
  t.agent = agent.id;
  t.txHash = event.transaction.hash;
  t.to = event.params.to;
  t.amount = event.params.amount;
  t.txTier = 0; // ROUTINE
  t.tag = new Bytes(0);
  t.executed = true;
  t.blockTimestamp = event.block.timestamp;
  t.save();
}

export function handleClassified(event: Classified): void {
  // Classified(ROUTINE) is immediately followed by ExecutedRoutine —
  // recorded there to avoid double-counting. Here we only record
  // non-routine classifications (ELEVATED→Held, VIOLATION→blocked),
  // which do not emit ExecutedRoutine.
  if (event.params.tier == 0) return;

  const agent = loadAgent(event.address);
  const t = new Transaction(eventId(event));
  t.agent = agent.id;
  t.txHash = event.transaction.hash;
  t.to = event.params.to;
  t.amount = event.params.amount;
  t.txTier = event.params.tier;
  t.tag = event.params.tag;
  t.executed = false;
  t.blockTimestamp = event.block.timestamp;
  t.save();

  if (event.params.tier == 2) {
    // VIOLATION — blocked before broadcast; a pricing near-miss.
    noteIncident(agent, event.block.timestamp);
  }
}

export function handleHeld(event: Held): void {
  const agent = loadAgent(event.address);

  const t = new Transaction(eventId(event));
  t.agent = agent.id;
  t.txHash = event.transaction.hash;
  t.to = event.params.to;
  t.amount = event.params.amount;
  t.txTier = 1; // ELEVATED
  t.tag = new Bytes(0);
  t.executed = false;
  t.blockTimestamp = event.block.timestamp;
  t.save();

  const h = new Hold(event.params.holdId.toString());
  h.agent = agent.id;
  h.transaction = t.id;
  h.to = event.params.to;
  h.amount = event.params.amount;
  h.releaseAt = BigInt.fromUInt64(event.params.releaseAt);
  h.extendedTo = zeroBigInt();
  h.status = HOLD_PENDING;
  h.createdAt = event.block.timestamp;
  h.save();
}

export function handleReleased(event: Released): void {
  const h = Hold.load(event.params.holdId.toString());
  if (h !== null) {
    h.status = HOLD_RELEASED;
    h.resolvedAt = event.block.timestamp;
    h.resolvedBy = event.address; // the GuardAccount (via verdictContract)
    h.save();
    const t = Transaction.load(h.transaction);
    if (t !== null) {
      t.executed = true; // funds moved on release
      t.save();
    }
  }
}

export function handleOwnerDecision(event: OwnerDecision): void {
  const h = Hold.load(event.params.holdId.toString());
  if (h === null) return;
  const d = event.params.decision;
  if (d == DECISION_APPROVE) {
    h.status = HOLD_OWNER_APPROVED;
  } else if (d == DECISION_FREEZE) {
    h.status = HOLD_OWNER_FROZEN;
  } else if (d == DECISION_FREEZE_ROTATE) {
    h.status = HOLD_OWNER_FROZEN_ROTATED;
  } else if (d == 0xff) {
    h.status = HOLD_WATCHER_FROZEN; // watcher-frozen sentinel
  } else if (d == 0xfe) {
    h.status = HOLD_AUTO_FROZEN; // auto-frozen (hold lapse) sentinel
  } else {
    h.status = HOLD_FROZEN;
  }
  h.resolvedAt = event.block.timestamp;
  h.resolvedBy = event.params.actor;
  h.save();
}

export function handleHoldLapsed(event: HoldLapsed): void {
  const h = Hold.load(event.params.holdId.toString());
  if (h !== null) {
    h.extendedTo = BigInt.fromUInt64(event.params.extendedTo);
    h.save();
  }
}

export function handleViolationBlocked(event: ViolationBlocked): void {
  const agent = loadAgent(event.address);
  const t = new Transaction(eventId(event));
  t.agent = agent.id;
  t.txHash = event.transaction.hash;
  t.to = event.params.to;
  t.amount = event.params.amount;
  t.txTier = 2; // VIOLATION
  t.tag = event.params.tag;
  t.executed = false;
  t.blockTimestamp = event.block.timestamp;
  t.save();
  noteIncident(agent, event.block.timestamp);
}

export function handleGuardAttemptedBreach(event: AttemptedBreach): void {
  const agent = loadAgent(event.address);
  noteIncident(agent, event.block.timestamp);
}

export function handleAuthorityRevoked(event: AuthorityRevoked): void {
  const agent = loadAgent(event.address);
  noteIncident(agent, event.block.timestamp);
}

export function handleAgentKeyRotated(event: AgentKeyRotated): void {
  // Key rotation is a security event, not a claim incident; recorded on
  // the agent for the résumé's ALIBI/DRIVING narrative only.
  loadAgent(event.address).save();
}

export function handleWithdrawn(event: Withdrawn): void {
  const agent = loadAgent(event.address);
  const f = new PoolFlow(eventId(event));
  f.type = "WITHDRAWN";
  f.amount = event.params.amount;
  f.tranche = null;
  f.depositor = null;
  f.claimant = event.params.to;
  f.agent = agent.guardAddress;
  f.juniorLoss = null;
  f.seniorLoss = null;
  f.reinsuranceLoss = null;
  f.blockTimestamp = event.block.timestamp;
  f.save();
}

export function handleGuardVerdictContractSet(event: GuardVerdictContractSet): void {
  // wiring only — no state entities
}

export function handleReceived(event: Received): void {
  const agent = loadAgent(event.address);
  const f = new PoolFlow(eventId(event));
  f.type = "RECEIVED";
  f.amount = event.params.value;
  f.tranche = null;
  f.depositor = event.params.from;
  f.claimant = null;
  f.agent = agent.guardAddress;
  f.juniorLoss = null;
  f.seniorLoss = null;
  f.reinsuranceLoss = null;
  f.blockTimestamp = event.block.timestamp;
  f.save();
}

// ------------------------------------------------------------------ //
//                       VerdictContract                              //
// ------------------------------------------------------------------ //

export function handleVerdictAccepted(event: VerdictAccepted): void {
  const agent = loadAgent(event.params.agent);
  const digest = event.params.digest;

  const v = new Verdict(digest.toHexString());
  v.agent = agent.id;
  const policy = Policy.load(agent.id);
  v.policy = policy !== null ? policy.id : null;
  v.outcome = event.params.outcome;
  v.payout = event.params.payout;
  v.alibi = event.params.alibi;
  v.digest = digest;
  v.acceptedAt = event.block.timestamp;
  v.reopenCount = zeroBigInt();
  v.save();

  // Claim recording (§13): covered → pool payout; denied → claim scar.
  const outcome = event.params.outcome;
  if (outcome == OUTCOME_COVERED || outcome == OUTCOME_DENIED_OWNER_ORIGIN) {
    const c = new Claim(digest.toHexString());
    c.verdict = v.id;
    c.agent = agent.id;
    c.claimant = agent.guardAddress; // payout target is the guard owner
    c.payout = outcome == OUTCOME_COVERED ? event.params.payout : zeroBigInt();
    c.covered = outcome == OUTCOME_COVERED;
    c.denied = outcome == OUTCOME_DENIED_OWNER_ORIGIN;
    c.paidAt = outcome == OUTCOME_COVERED ? event.block.timestamp : null;
    c.blockTimestamp = event.block.timestamp;
    c.save();
  }

  // An accepted breach-y outcome resets the clean streak (§12 pricing).
  if (outcome == OUTCOME_ATTEMPTED_BREACH || outcome == OUTCOME_COVERED) {
    noteIncident(agent, event.block.timestamp);
  }
}

export function handleAttemptedBreachSignal(event: AttemptedBreachSignal): void {
  const agent = loadAgent(event.params.agent);
  const v = new Verdict(event.params.txHash.toHexString());
  v.agent = agent.id;
  const policy = Policy.load(agent.id);
  v.policy = policy !== null ? policy.id : null;
  v.outcome = OUTCOME_ATTEMPTED_BREACH;
  v.payout = zeroBigInt();
  v.alibi = 0; // UNKNOWN — signal only
  v.digest = event.params.txHash;
  v.acceptedAt = event.block.timestamp;
  v.reopenCount = zeroBigInt();
  v.save();
  noteIncident(agent, event.block.timestamp);
}

export function handleHoldVerdictRouted(event: HoldVerdictRouted): void {
  const h = Hold.load(event.params.holdId.toString());
  if (h !== null && !event.params.clean) {
    // Suspicious → the verdict contract freezes the hold (watcher path);
    // a subsequent Released event may still resolve it owner-approved.
    h.status = HOLD_FROZEN;
    h.resolvedAt = event.block.timestamp;
    h.resolvedBy = event.address;
    h.save();
  }
}

export function handleReopened(event: Reopened): void {
  const v = Verdict.load(event.params.digest.toHexString());
  if (v !== null) {
    v.reopenCount = v.reopenCount.plus(BigInt.fromI32(1));
    v.save();
  }
}

export function handleEscalated(event: Escalated): void {
  // v2 arbitration — not emitted in v1; kept for schema completeness.
}

export function handleArbitrationConcluded(event: ArbitrationConcluded): void {
  const v = Verdict.load(event.params.digest.toHexString());
  if (v !== null && event.params.overturned) {
    v.outcome = OUTCOME_DISMISSED;
    v.save();
  }
}

export function handleStrikeRecorded(event: StrikeRecorded): void {
  const destId = event.params.destination.toHexString();
  let entry = BlocklistEntry.load(destId);
  if (entry === null) {
    entry = new BlocklistEntry(destId);
    entry.destination = event.params.destination;
    entry.cleared = false;
    entry.evidence = null;
  }
  entry.strikes = event.params.strikes;
  entry.flagged = event.params.strikes >= 3;
  entry.save();
}

export function handleWatcherSet(event: WatcherSet): void {
  // wiring only
}

export function handlePoolSet(event: PoolSet): void {
  // wiring only
}

export function handleArbiterSet(event: ArbiterSet): void {
  // wiring only
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
    entry.cleared = false;
    entry.evidence = null;
  }
  entry.strikes = event.params.strikes;
  entry.flagged = event.params.strikes >= 3;
  entry.evidence = event.params.evidence;
  entry.save();

  const report = new Report(eventId(event));
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
    entry.cleared = true;
    entry.save();
  }
}

export function handleAdminChanged(event: AdminChanged): void {
  // governance only
}

export function handleReporterSet(event: ReporterSet): void {
  // governance only
}

// ------------------------------------------------------------------ //
//                         MutualPool                                 //
// ------------------------------------------------------------------ //

function loadPool(): PoolState {
  let pool = PoolState.load("pool");
  if (pool === null) {
    pool = new PoolState("pool");
    pool.juniorCapital = zeroBigInt();
    pool.seniorCapital = zeroBigInt();
    pool.premiumPool = zeroBigInt();
    pool.totalPayouts = zeroBigInt();
    pool.claimCount = 0;
    pool.updatedAt = zeroBigInt();
  }
  return pool;
}

export function handleDeposited(event: Deposited): void {
  const pool = loadPool();
  if (event.params.tranche == 0) {
    pool.seniorCapital = pool.seniorCapital.plus(event.params.assets);
  } else {
    pool.juniorCapital = pool.juniorCapital.plus(event.params.assets);
  }
  pool.updatedAt = event.block.timestamp;
  pool.save();

  const f = new PoolFlow(eventId(event));
  f.type = "DEPOSIT";
  f.amount = event.params.assets;
  f.tranche = event.params.tranche;
  f.depositor = event.params.depositor;
  f.claimant = null;
  f.agent = null;
  f.digest = null;
  f.juniorLoss = null;
  f.seniorLoss = null;
  f.reinsuranceLoss = null;
  f.blockTimestamp = event.block.timestamp;
  f.save();
}

export function handleRedeemed(event: Redeemed): void {
  const pool = loadPool();
  if (event.params.tranche == 0) {
    pool.seniorCapital = pool.seniorCapital.minus(event.params.assets);
  } else {
    pool.juniorCapital = pool.juniorCapital.minus(event.params.assets);
  }
  pool.updatedAt = event.block.timestamp;
  pool.save();

  const f = new PoolFlow(eventId(event));
  f.type = "REDEEM";
  f.amount = event.params.assets;
  f.tranche = event.params.tranche;
  f.depositor = event.params.depositor;
  f.claimant = null;
  f.agent = null;
  f.digest = null;
  f.juniorLoss = null;
  f.seniorLoss = null;
  f.reinsuranceLoss = null;
  f.blockTimestamp = event.block.timestamp;
  f.save();
}

export function handlePayout(event: PayoutEvent): void {
  const pool = loadPool();
  pool.totalPayouts = pool.totalPayouts.plus(event.params.amount);
  pool.claimCount += 1;
  pool.updatedAt = event.block.timestamp;
  pool.save();

  const f = new PoolFlow(eventId(event));
  f.type = "PAYOUT";
  f.amount = event.params.amount;
  f.tranche = null;
  f.depositor = null;
  f.claimant = event.params.claimant;
  f.agent = null;
  f.digest = event.params.digest;
  f.juniorLoss = null;
  f.seniorLoss = null;
  f.reinsuranceLoss = null;
  f.blockTimestamp = event.block.timestamp;
  f.save();

  // Mark the claim paid (claimant here is the actual transfer target).
  const claim = Claim.load(event.params.digest.toHexString());
  if (claim !== null) {
    claim.claimant = event.params.claimant;
    claim.payout = event.params.amount;
    claim.paidAt = event.block.timestamp;
    claim.save();
  }
}

export function handlePremiumRecorded(event: PremiumRecorded): void {
  const pool = loadPool();
  pool.premiumPool = pool.premiumPool.plus(event.params.amount);
  pool.updatedAt = event.block.timestamp;
  pool.save();

  const f = new PoolFlow(eventId(event));
  f.type = "PREMIUM";
  f.amount = event.params.amount;
  f.tranche = null;
  f.depositor = null;
  f.claimant = null;
  f.agent = event.params.agent;
  f.digest = null;
  f.juniorLoss = null;
  f.seniorLoss = null;
  f.reinsuranceLoss = null;
  f.blockTimestamp = event.block.timestamp;
  f.save();
}

export function handleLossApplied(event: LossApplied): void {
  const pool = loadPool();
  pool.juniorCapital = pool.juniorCapital.minus(event.params.juniorLoss);
  pool.seniorCapital = pool.seniorCapital.minus(event.params.seniorLoss);
  pool.updatedAt = event.block.timestamp;
  pool.save();

  const f = new PoolFlow(eventId(event));
  f.type = "LOSS";
  f.amount = event.params.amount;
  f.tranche = null;
  f.depositor = null;
  f.claimant = null;
  f.agent = null;
  f.digest = null;
  f.juniorLoss = event.params.juniorLoss;
  f.seniorLoss = event.params.seniorLoss;
  f.reinsuranceLoss = event.params.reinsuranceLoss;
  f.blockTimestamp = event.block.timestamp;
  f.save();
}

export function handleReinsuranceHooked(event: ReinsuranceHooked): void {
  const f = new PoolFlow(eventId(event));
  f.type = "REINSURANCE";
  f.amount = event.params.attachment;
  f.tranche = null;
  f.depositor = null;
  f.claimant = null;
  f.agent = null;
  f.digest = null;
  f.juniorLoss = null;
  f.seniorLoss = null;
  f.reinsuranceLoss = null;
  f.blockTimestamp = event.block.timestamp;
  f.save();
}

export function handlePoolVerdictContractSet(event: PoolVerdictContractSet): void {
  // wiring only
}

// ------------------------------------------------------------------ //
//                            USDCMock                                //
// ------------------------------------------------------------------ //

export function handleUsdcTransfer(event: UsdcTransfer): void {
  const t = new Transfer(eventId(event));
  t.from = event.params.from;
  t.to = event.params.to;
  t.value = event.params.value;
  t.blockTimestamp = event.block.timestamp;
  t.save();
}

export function handleUsdcApproval(event: Approval): void {
  // approvals are pre-conditions of pool deposits; nothing to project
}
