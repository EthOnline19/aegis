/**
 * Risk Posture tests — the graph→engine projection layer.
 *
 * postureFromGraph() is a pure function of (GraphQL payload, nowSec): these
 * tests pin the mapping from subgraph entities (streak, verdicts, claims)
 * into @bulwark/engine DrivingRecord/quote() inputs, the anomaly flags,
 * and the deterministic NL summary. Fixture payloads mirror the deployed
 * Risk Subgraph schema (packages/subgraph/schema.graphql) exactly — no
 * live endpoint required.
 */

import { describe, expect, test } from "bun:test";

import { postureFromGraph } from "../scripts/query-graph.ts";

/** Fixed Unix SECONDS (engine quote() convention: NOW=1_772_000_000). */
const T0 = 1_772_000_000;
const DAY = 86_400;

/** The Step-4 live run shape (agentId 894341 mirrored at the guard): one
 *  covered verdict → pool payout, streak reset, SDK installed, active
 *  policy. */
interface FixtureAgent {
  id: string;
  guardAddress: string;
  streak: string;
  totalRoutineTx: string;
  totalAttempts: string;
  lastIncidentAt: string | null;
  policy: {
    cap: string;
    sdkInstalled: boolean;
    revoked: boolean;
    revokedAt: string | null;
  } | null;
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

function fixture(overrides: Partial<FixtureAgent> = {}): FixtureAgent {
  return {
    id: "0x9675b4d20d2acfe55d00a02d55b9cdb57aebd482",
    guardAddress: "0x9675b4D20d2ACFE55D00a02D55B9cdb57AEbD482",
    streak: "14",
    totalRoutineTx: "120",
    totalAttempts: "0",
    lastIncidentAt: null,
    policy: {
      cap: "2500000000",
      sdkInstalled: true,
      revoked: false,
      revokedAt: null,
    },
    verdicts: [],
    claims: [],
    ...overrides,
  };
}

describe("postureFromGraph", () => {
  test("agent not found → watch-only max pricing with AGENT_NOT_FOUND flag", () => {
    const p = postureFromGraph(null, T0, 2500);
    expect(p.anomalies).toContain("AGENT_NOT_FOUND");
    // ×2 watch-only × 1.4 anomaly load; no SDK/KYA discounts.
    expect(p.multiplier).toBeCloseTo(2.8, 6);
    expect(p.monthlyPremiumUsdc).toBeCloseTo(2500 * 0.02 * 2.8, 6);
    expect(p.summary).toContain("Unknown agent");
  });

  test("clean agent with streak → streak discount + SDK only", () => {
    const p = postureFromGraph(fixture(), T0, 2500);
    // 14/180 clean days → −4.67%; SDK installed → −10%
    expect(p.multiplier).toBeCloseTo((1 - 0.6 * (14 / 180)) * 0.9, 6);
    expect(p.reasons.map((r) => r.tag)).toEqual([
      "STREAK_DISCOUNT",
      "SDK_DISCOUNT",
    ]);
    expect(p.anomalies).toEqual([]);
    expect(p.summary).toContain("14 clean streak day(s)");
    expect(p.summary).toContain("120 routine transaction(s)");
  });

  test("step-4 shape: covered claim resets streak → CLAIM_LOAD + POST_CLAIM_NO_STREAK", () => {
    const digest =
      "0x1af03bc6a70b6309bd5c9ec92c7d78c1024e0d69c9ea5ea60faf828c958ed3f0";
    const a = fixture({
      streak: "0",
      verdicts: [
        {
          id: digest,
          outcome: 1, // COVERED
          payout: "135000000",
          alibi: 1,
          acceptedAt: String(T0 - 10 * DAY),
        },
      ],
      claims: [
        {
          id: digest,
          covered: true,
          denied: false,
          payout: "135000000",
          paidAt: String(T0 - 10 * DAY),
        },
      ],
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.multiplier).toBeCloseTo(3 * 0.9, 6); // ×3 claim load, −10% SDK
    expect(p.reasons.map((r) => r.tag)).toContain("CLAIM_LOAD");
    expect(p.anomalies).toContainEqual(
      expect.stringContaining("POST_CLAIM_NO_STREAK"),
    );
    expect(p.summary).toContain("1 paid claim(s)");
  });

  test("attempted breach within 30 days → ATTEMPT_LOAD + ANOMALY_LOAD + flag", () => {
    const a = fixture({
      verdicts: [
        {
          id: "0xabc",
          outcome: 3,
          payout: "0",
          alibi: 0,
          acceptedAt: String(T0 - 5 * DAY),
        },
      ],
      totalAttempts: "1",
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.reasons.map((r) => r.tag)).toContain("ATTEMPT_LOAD");
    expect(p.reasons.map((r) => r.tag)).toContain("ANOMALY_LOAD");
    expect(p.anomalies.some((x) => x.startsWith("ATTEMPTED_BREACH_30D"))).toBe(
      true,
    );
  });

  test("attempted breach older than 30 days → no ATTEMPT_LOAD", () => {
    const a = fixture({
      verdicts: [
        {
          id: "0xabc",
          outcome: 3,
          payout: "0",
          alibi: 0,
          acceptedAt: String(T0 - 31 * DAY),
        },
      ],
      totalAttempts: "1",
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.reasons.map((r) => r.tag)).not.toContain("ATTEMPT_LOAD");
    expect(p.anomalies).toEqual([]);
  });

  test("owner-fraud denial → heavy anomaly load (0.8)", () => {
    const a = fixture({
      verdicts: [
        {
          id: "0xdead",
          outcome: 2,
          payout: "0",
          alibi: 2,
          acceptedAt: String(T0 - 40 * DAY),
        },
      ],
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.drivingRecord.anomalyLoad).toBe(0.8);
  });

  test("revoked policy → watch-only load + POLICY_REVOKED flag", () => {
    const a = fixture({
      policy: { cap: "1", sdkInstalled: false, revoked: true, revokedAt: "1" },
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.reasons.map((r) => r.tag)).toContain("WATCH_ONLY_LOAD");
    expect(p.anomalies).toContain(
      "POLICY_REVOKED: coverage revoked — priced watch-only",
    );
  });

  test("two lifetime claims, both recent → repeat ×5 + REPEAT_CLAIMS flag", () => {
    const a = fixture({
      streak: "0",
      claims: [
        {
          id: "0x1",
          covered: true,
          denied: false,
          payout: "100",
          paidAt: String(T0 - 30 * DAY),
        },
        {
          id: "0x2",
          covered: true,
          denied: false,
          payout: "100",
          paidAt: String(T0 - 31 * DAY),
        },
      ],
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.reasons.map((r) => r.tag)).toContain("CLAIM_LOAD");
    expect(p.anomalies.some((x) => x.startsWith("REPEAT_CLAIMS"))).toBe(true);
    expect(p.multiplier).toBeCloseTo(5 * 0.9, 6);
  });

  test("old claim outside 6-month window → no CLAIM_LOAD, lifetime count kept", () => {
    const a = fixture({
      claims: [
        {
          id: "0x1",
          covered: true,
          denied: false,
          payout: "100",
          paidAt: String(T0 - 200 * DAY),
        },
      ],
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.reasons.map((r) => r.tag)).not.toContain("CLAIM_LOAD");
    expect(p.drivingRecord.lifetimeClaims).toBe(1);
  });

  test("attempts but zero routines → ATTEMPTS_NO_ROUTINES flag", () => {
    const a = fixture({
      streak: "0",
      totalRoutineTx: "0",
      totalAttempts: "2",
      verdicts: [
        {
          id: "0xb",
          outcome: 3,
          payout: "0",
          alibi: 0,
          acceptedAt: String(T0 - DAY),
        },
      ],
    });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.anomalies).toContain(
      "ATTEMPTS_NO_ROUTINES: breach attempts with no clean history",
    );
  });

  test("no policy entity → watchOnly priced", () => {
    const a = fixture({ policy: null });
    const p = postureFromGraph(a, T0, 2500);
    expect(p.drivingRecord.watchOnly).toBe(true);
    expect(p.reasons.map((r) => r.tag)).toContain("WATCH_ONLY_LOAD");
  });

  test("determinism: identical payload+nowSec → identical posture", () => {
    const a = fixture();
    const p1 = postureFromGraph(a, T0, 2500);
    const p2 = postureFromGraph(structuredClone(a), T0, 2500);
    expect(p1).toEqual(p2);
    expect(p1.summary).toBe(p2.summary);
  });
});
