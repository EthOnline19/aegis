/**
 * Live AI consumer — Risk Posture from the deployed Risk Subgraph.
 *
 * Queries the deployed REPAYD Risk Subgraph GraphQL endpoint (env
 * GRAPH_API_URL; Studio endpoints carry ?jwt=<GRAPH_API_KEY>), projects the
 * on-chain history (streak, verdicts, claims) into the @bulwark/engine
 * `quote()` inputs, and emits the Risk Posture: multiplier, monthly premium,
 * labeled reasons, a deterministic natural-language summary, and anomaly
 * flags. NO hardcoded data — every number traces to a GraphQL field.
 *
 * Usage:
 *   GRAPH_API_URL=<endpoint> bun run packages/api/scripts/query-graph.ts
 *   (no GRAPH_API_URL → dry-run: prints the exact query and exits 0)
 *   GRAPH_API_KEY=<key>  (Studio deployed-subgraph auth; appended as ?jwt=)
 *   AGENT_ID=<guard address>  (required for live mode; dry-run uses placeholder)
 *   COVERAGE_CAP_USDC=<whole USDC>  (default 2500)
 */

import { quote, type DrivingRecord, USDC_DECIMALS } from "@bulwark/engine";

/** Agent-level projection of the Risk Subgraph (matches schema.graphql). */
interface GraphAgent {
  id: string;
  guardAddress: string;
  streak: string;
  totalRoutineTx: string;
  totalAttempts: string;
  lastIncidentAt: string | null;
  policy: { cap: string; sdkInstalled: boolean; revoked: boolean } | null;
  verdicts: Array<{
    id: string;
    outcome: number;
    payout: string;
    alibi: number;
    acceptedAt: string;
  }>;
  claims: Array<{
    id: string;
    covered: boolean;
    denied: boolean;
    payout: string;
    paidAt: string | null;
  }>;
}

interface RiskPosture {
  agent: string;
  source: string;
  queriedAt: string;
  drivingRecord: DrivingRecord;
  multiplier: number;
  monthlyPremiumUsdc: number;
  reasons: ReadonlyArray<{ tag: string; detail: string }>;
  summary: string;
  anomalies: string[];
}

const OUTCOME = {
  NONE: 0,
  COVERED: 1,
  DENIED_OWNER_ORIGIN: 2,
  ATTEMPTED_BREACH: 3,
  DISMISSED: 4,
} as const;

/** The exact query the AI consumer issues. Dry-run prints it verbatim. */
export const RISK_QUERY = `query RiskPosture($agent: ID!) {
  agent(id: $agent) {
    id
    guardAddress
    streak
    totalRoutineTx
    totalAttempts
    lastIncidentAt
    policy {
      cap
      sdkInstalled
      revoked
      revokedAt
    }
    verdicts(orderBy: acceptedAt, orderDirection: desc, first: 50) {
      id
      outcome
      payout
      alibi
      acceptedAt
    }
    claims(orderBy: blockTimestamp, orderDirection: desc, first: 50) {
      id
      covered
      denied
      payout
      paidAt
    }
  }
}`;

// All posture timestamps are SECONDS (block timestamps; engine `quote`
// convention — packages/engine/test/pricing.test.ts NOW=1_772_000_000).
const SIX_MONTHS_SEC = 182 * 86_400;
const THIRTY_DAYS_SEC = 30 * 86_400;

/**
 * Project the GraphQL payload into engine inputs + the Risk Posture.
 * Pure function of (payload, nowSec) — the unit-testable core.
 * `nowSec` is Unix SECONDS; `nowSec < 0` means "no clock" (tests pass a
 * fixed second-epoch; the CLI passes Math.floor(Date.now()/1000)).
 */
export function postureFromGraph(
  agent: GraphAgent | null,
  nowSec: number,
  coverageCapUsdc = 2500,
): RiskPosture {
  const cap = BigInt(Math.round(coverageCapUsdc)) * 10n ** BigInt(USDC_DECIMALS);

  if (agent === null) {
    // Unknown agent: worst-case record — the engine prices the unknown.
    const record: DrivingRecord = {
      cleanStreakDays: 0,
      anomalyLoad: 1,
      attemptedBreaches: [],
      recentClaims: [],
      lifetimeClaims: 0,
      worldIdVerified: false,
      sdkInstalled: false,
      watchOnly: true,
      now: nowSec,
    };
    const q = quote(record, cap);
    return {
      agent: "unknown",
      source: "graph:agent-not-found",
      queriedAt: new Date(nowSec * 1000).toISOString(),
      drivingRecord: record,
      multiplier: q.multiplier,
      monthlyPremiumUsdc: Number(q.monthlyPremium) / 10 ** USDC_DECIMALS,
      reasons: q.reasons.map((r) => ({ tag: r.tag, detail: r.detail })),
      summary:
        "Unknown agent — no subgraph history. Priced at watch-only maximum " +
        `until first on-chain routine establishes a record (multiplier ${q.multiplier.toFixed(2)}x).`,
      anomalies: ["AGENT_NOT_FOUND"],
    };
  }

  // --- VERIFIED: streak (subgraph counts clean ExecutedRoutine txs since
  // last strike/attempt). Days: floor(streak / expected daily routines)?
  // No — streak is txs, not days; the guard emits at most one routine/UTC
  // day by velocity, so txs ≈ active days. Use it directly, floored.
  const cleanStreakDays = Math.min(Number(agent.streak), 180);

  // --- VERIFIED: recent paid claims (6-month window) and lifetime count.
  const recentClaimTimestamps = agent.claims
    .filter((c) => c.covered && c.paidAt !== null)
    .map((c) => Number(c.paidAt))
    .filter((t) => nowSec - t < SIX_MONTHS_SEC);

  // --- VERIFIED: attempted breaches (outcome 3) in the last 30 days.
  const attemptedBreaches = agent.verdicts
    .filter((v) => v.outcome === OUTCOME.ATTEMPTED_BREACH)
    .map((v) => Number(v.acceptedAt))
    .filter((t) => nowSec - t < THIRTY_DAYS_SEC);

  // Anomaly load: recent attack pressure normalized into 0..1.
  // Two components: recent attempted breaches (30d) and owner-fraud denials
  // (worst signal). 0.4 per recent attempt capped at 1.
  let anomalyLoad = attemptedBreaches.length * 0.4;
  if (agent.verdicts.some((v) => v.outcome === OUTCOME.DENIED_OWNER_ORIGIN)) {
    anomalyLoad = Math.max(anomalyLoad, 0.8);
  }
  anomalyLoad = Math.min(anomalyLoad, 1);

  const record: DrivingRecord = {
    cleanStreakDays,
    anomalyLoad,
    attemptedBreaches,
    recentClaims: recentClaimTimestamps,
    lifetimeClaims: agent.claims.filter((c) => c.covered).length,
    worldIdVerified: false,
    sdkInstalled: agent.policy?.sdkInstalled ?? false,
    watchOnly: !agent.policy || agent.policy.revoked,
    now: nowSec,
  };
  const q = quote(record, cap);

  // --- Anomaly flags (deterministic reads of the same payload).
  const anomalies: string[] = [];
  if (attemptedBreaches.length > 0) {
    anomalies.push(
      `ATTEMPTED_BREACH_30D: ${attemptedBreaches.length} blocked attack(s) in the last 30 days`,
    );
  }
  const coveredClaimCount = agent.claims.filter((c) => c.covered).length;
  if (coveredClaimCount >= 2) {
    anomalies.push(
      `REPEAT_CLAIMS: ${coveredClaimCount} lifetime paid claims → ×5 load while any is within 6 months`,
    );
  }
  if (agent.policy?.revoked) {
    anomalies.push("POLICY_REVOKED: coverage revoked — priced watch-only");
  }
  if (
    agent.verdicts.some(
      (v) => v.outcome === OUTCOME.COVERED && Number(v.payout) > 0,
    ) &&
    cleanStreakDays === 0
  ) {
    anomalies.push(
      "POST_CLAIM_NO_STREAK: paid payout on record but streak reset to zero — high moral-hazard window",
    );
  }
  if (Number(agent.totalAttempts) > 0 && Number(agent.totalRoutineTx) === 0) {
    anomalies.push("ATTEMPTS_NO_ROUTINES: breach attempts with no clean history");
  }

  return {
    agent: agent.guardAddress,
    source: "graph",
    queriedAt: new Date(nowSec * 1000).toISOString(),
    drivingRecord: record,
    multiplier: q.multiplier,
    monthlyPremiumUsdc: Number(q.monthlyPremium) / 10 ** USDC_DECIMALS,
    reasons: q.reasons.map((r) => ({ tag: r.tag, detail: r.detail })),
    summary: summarize(agent, record, q.multiplier, anomalies),
    anomalies,
  };
}

/** Deterministic NL summary — same payload, same sentence, forever. */
function summarize(
  agent: GraphAgent,
  record: DrivingRecord,
  multiplier: number,
  anomalies: string[],
): string {
  const parts: string[] = [];
  parts.push(
    `Agent ${agent.guardAddress} shows ${record.cleanStreakDays} clean streak day(s) ` +
      `across ${agent.totalRoutineTx} routine transaction(s)`,
  );
  if (record.lifetimeClaims > 0) {
    parts.push(
      `${record.lifetimeClaims} paid claim(s) on record (most recent within 6 months: ${record.recentClaims.length > 0 ? "yes" : "no"})`,
    );
  }
  if (record.attemptedBreaches.length > 0) {
    parts.push(
      `${record.attemptedBreaches.length} attempted breach(es) in the last 30 days`,
    );
  }
  parts.push(`risk multiplier ${multiplier.toFixed(2)}x`);
  if (anomalies.length > 0) {
    parts.push(`${anomalies.length} anomaly flag(s): ${anomalies.map((a) => a.split(":")[0]).join(", ")}`);
  }
  return parts.join("; ") + ".";
}

// ------------------------------------------------------------------- //
//                              CLI                                    //
// ------------------------------------------------------------------- //

function graphEndpoint(): string | null {
  const raw = process.env.GRAPH_API_URL;
  if (!raw) return null;
  const key = process.env.GRAPH_API_KEY;
  if (!key) return raw;
  const sep = raw.includes("?") ? "&" : "?";
  return `${raw}${sep}jwt=${key}`;
}

async function main(): Promise<number> {
  const endpoint = graphEndpoint();
  const agent = process.env.AGENT_ID ?? "0x0";

  if (!endpoint) {
    // DRY-RUN (default): print the exact query that live mode would send.
    console.log("REPAYD Risk Posture consumer — DRY RUN (set GRAPH_API_URL to go live)");
    console.log(`endpoint:   $GRAPH_API_URL (unset) — Studio format: https://api.studio.thegraph.com/query/<id>/<slug>/<version>?jwt=$GRAPH_API_KEY`);
    console.log(`agent:      $AGENT_ID (placeholder "${agent}" — set the GuardAccount address)`);
    console.log(`coverage:   $COVERAGE_CAP_USDC (default 2500 USDC)`);
    console.log("\nexact GraphQL query:");
    console.log(RISK_QUERY);
    return 0;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: RISK_QUERY,
      variables: { agent: agent.toLowerCase() },
    }),
  });
  if (!res.ok) {
    console.error(`graph query failed: HTTP ${res.status}: ${await res.text()}`);
    return 1;
  }
  const body = (await res.json()) as {
    data?: { agent: GraphAgent | null };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    console.error("graph errors:", JSON.stringify(body.errors, null, 2));
    return 1;
  }

  const cap = Number(process.env.COVERAGE_CAP_USDC ?? "2500");
  const posture = postureFromGraph(
    body.data?.agent ?? null,
    Math.floor(Date.now() / 1000),
    cap,
  );
  console.log(JSON.stringify(posture, null, 2));
  return 0;
}

// CLI entry — tests import the pure functions instead.
if (import.meta.main) {
  process.exit(await main());
}
