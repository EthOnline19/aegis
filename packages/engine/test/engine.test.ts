import { describe, expect, it } from "vitest";

import {
  Alibi,
  Outcome,
  Provenance,
  computePayout,
  curfewActive,
  effectiveLimit,
  isAllowlisted,
  type BehavioralFacts,
  type Policy,
  type Transaction,
} from "../src/index.ts";
import { judgeBreach, judgeHold, sigmaDeviation, sqrtApprox } from "../src/engine.ts";

// --------------------------------------------------------------------- //
//                     Atlas's world (plan §15)                          //
// --------------------------------------------------------------------- //

const ALICE = "0x328809bc894f92807417d2dad6b7c998c1afdac6" as const;
const BOB = "0x1d96f2f6bef1202e4ce1ff6dad0c2cb002861d3e" as const;
const CAROL = "0xa4d4c1f8a763ef6a0140d04291eceef913ffc272" as const;
const FRESH = "0x55405807c2766d2cb3724d671cc6c30458de6501" as const;
const ATTACKER = "0x00000000000000000000000000000000000attac" as unknown as `0x${string}`;

const POLICY: Policy = {
  version: 4,
  agent: "0xatlas" as unknown as `0x${string}`,
  owner: "0xamara" as unknown as `0x${string}`,
  coverageCap: 2_500_000_000n,
  deductibleBps: 1000,
  perTxLimit: 200_000_000n,
  dailyLimit: 1_0_000_000n,
  velocityLimit: 5,
  allowlist: [
    { recipient: ALICE, cap: 200_000_000n },
    { recipient: BOB, cap: 400_000_000n },
  ],
  curfewStartMinute: 1440,
  curfewEndMinute: 1440,
  holdWindowSec: 120,
  sdkInstalled: true,
};

const QUIET_FACTS: BehavioralFacts = {
  recipientFirstSeen: 1_700_000_000,
  recipientOnBlocklistStrikes: 0,
  knownDrainerCalldata: false,
  hourOfDayHistory: [9, 10, 11, 12, 13, 14, 15, 16, 17],
  amountHistory: [150n, 180n, 220n, 90n, 310n].map((a) => BigInt(a) * 1_000_000n),
};

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    to: ALICE,
    amount: 150_000_000n,
    txHash: "0xtx" as `0x${string}`,
    blockTimestamp: 1_772_028_000, // 14:00 UTC, inside the agent's working hours
    calldata: "0x" as `0x${string}`,
    ...overrides,
  };
}

// --------------------------------------------------------------------- //
//                       Policy conformance                              //
// --------------------------------------------------------------------- //

describe("policy math", () => {
  it("sub-cap governs allowlisted payroll (Case 1)", () => {
    expect(effectiveLimit(POLICY, BOB)).toBe(400_000_000n);
    expect(effectiveLimit(POLICY, ALICE)).toBe(200_000_000n);
    expect(effectiveLimit(POLICY, CAROL)).toBe(200_000_000n);
    expect(isAllowlisted(POLICY, BOB)).toBe(true);
    expect(isAllowlisted(POLICY, CAROL)).toBe(false);
  });

  it("deductible: $150 loss → $135 payout (Case 5)", () => {
    expect(computePayout(150_000_000n, 1000, 2_500_000_000n)).toBe(135_000_000n);
  });

  it("payout floors at the coverage cap", () => {
    expect(computePayout(9_000_000_000n, 1000, 2_500_000_000n)).toBe(2_500_000_000n);
  });

  it("curfew handles overnight wrap", () => {
    const curfewPolicy = { ...POLICY, curfewStartMinute: 120, curfewEndMinute: 300 }; // 02:00–05:00
    const at3am = 3 * 3600;
    const atNoon = 12 * 3600;
    expect(curfewActive(curfewPolicy, at3am)).toBe(true);
    expect(curfewActive(curfewPolicy, atNoon)).toBe(false);

    const wrapPolicy = { ...POLICY, curfewStartMinute: 1320, curfewEndMinute: 300 }; // 22:00–05:00
    const at23 = 23 * 3600;
    expect(curfewActive(wrapPolicy, at23)).toBe(true);
    expect(curfewActive(wrapPolicy, at3am)).toBe(true);
    expect(curfewActive(wrapPolicy, atNoon)).toBe(false);
  });
});

// --------------------------------------------------------------------- //
//                    Hold-window judgment (Cases 2, 3)                  //
// --------------------------------------------------------------------- //

describe("judgeHold", () => {
  it("Case 2: new contractor Carol, benign facts → RELEASE", () => {
    const v = judgeHold(
      POLICY,
      tx({ to: CAROL, amount: 150_000_000n }),
      { ...QUIET_FACTS, recipientFirstSeen: 1_700_000_000 - 63_072_000 }, // funded 2y ago
    );
    // New recipient +1 only — clean verdict.
    expect(v.holdAction).toBe("RELEASE");
    expect(v.outcome).toBe(Outcome.NONE);
    expect(v.reasons.some((r) => r.tag === "NEW_RECIPIENT")).toBe(true);
  });

  it("Case 3: $900 to a 3-day-old wallet at 4AM → FREEZE", () => {
    const at4am = 1_772_000_000 - 1_772_000_000 % 86_400 + 4 * 3600;
    const v = judgeHold(
      POLICY,
      tx({ to: FRESH, amount: 900_000_000n, blockTimestamp: at4am }),
      { ...QUIET_FACTS, recipientFirstSeen: null },
    );
    expect(v.holdAction).toBe("FREEZE");
    expect(v.outcome).toBe(Outcome.ATTEMPTED_BREACH);
    // Every anomaly light fired: new recipient, brand-new wallet, unusual hour.
    const tags = v.reasons.map((r) => r.tag);
    expect(tags).toContain("NEW_RECIPIENT");
    expect(tags).toContain("RECIPIENT_BRAND_NEW");
    expect(tags).toContain("UNUSUAL_HOUR");
  });

  it("amount anomaly: 4.5σ above history scores", () => {
    const v = judgeHold(POLICY, tx({ amount: 900_000_000n }), QUIET_FACTS);
    expect(v.reasons.some((r) => r.tag === "AMOUNT_ANOMALY")).toBe(true);
  });

  it("blocklisted destination adds 3 points (hard flag)", () => {
    const v = judgeHold(
      POLICY,
      tx({ to: FRESH, amount: 100_000_000n }),
      { ...QUIET_FACTS, recipientOnBlocklistStrikes: 3, recipientFirstSeen: null },
    );
    expect(v.holdAction).toBe("FREEZE");
  });

  it("routine payroll is untouched: quiet facts → RELEASE with at most 1 signal", () => {
    const v = judgeHold(POLICY, tx({ amount: 180_000_000n }), QUIET_FACTS);
    expect(v.holdAction).toBe("RELEASE");
    expect(v.reasons.length).toBe(0);
  });
});

// --------------------------------------------------------------------- //
//                    Breach adjudication (Cases 5, 6)                   //
// --------------------------------------------------------------------- //

describe("judgeBreach", () => {
  it("Case 5: external look-alike attack → COVERED, $150→$135 same-block", () => {
    const v = judgeBreach(
      POLICY,
      tx({
        to: ATTACKER,
        amount: 150_000_000n,
        instruction: {
          digest: "0xinstr" as `0x${string}`,
          origin: "web",
          ownerSigned: false,
          timestamp: 1_772_000_000,
          teeCosigned: true,
          prev: "0x0" as `0x${string}`,
        },
      }),
      { ...QUIET_FACTS, recipientFirstSeen: null },
    );
    expect(v.outcome).toBe(Outcome.COVERED);
    expect(v.alibi).toBe(Alibi.EXTERNAL);
    expect(v.payoutAmount).toBe(135_000_000n);
    expect(v.reasons.some((r) => r.tag === "EXTERNAL_INJECTION")).toBe(true);
  });

  it("Case 5 full flow with instruction chain record", () => {
    const v = judgeBreach(
      POLICY,
      tx({
        to: ATTACKER,
        amount: 150_000_000n,
        instruction: {
          digest: "0xinstr" as `0x${string}`,
          origin: "web",
          ownerSigned: false,
          timestamp: 1_772_000_000,
          teeCosigned: true,
          prev: "0x0" as `0x${string}`,
        },
      }),
      { ...QUIET_FACTS, recipientFirstSeen: null },
    );
    expect(v.outcome).toBe(Outcome.COVERED);
    expect(v.payoutAmount).toBe(135_000_000n);
  });

  it("Case 6: Nuno's own instruction → DENIED_OWNER_ORIGIN, zero payout", () => {
    const v = judgeBreach(
      POLICY,
      tx({
        to: BOB,
        amount: 1_800_000_000n,
        instruction: {
          digest: "0xinstr" as `0x${string}`,
          origin: "owner-console",
          ownerSigned: true,
          timestamp: 1_772_000_000,
          teeCosigned: true,
          prev: "0x0" as `0x${string}`,
        },
      }),
      QUIET_FACTS,
    );
    expect(v.outcome).toBe(Outcome.DENIED_OWNER_ORIGIN);
    expect(v.alibi).toBe(Alibi.OWNER_SIGNED);
    expect(v.payoutAmount).toBe(0n);
    expect(v.reasons.some((r) => r.tag === "OWNER_ORIGIN")).toBe(true);
  });

  it("no SDK (watch-only): provenance unverifiable → capped tier (25%)", () => {
    const watchOnly = { ...POLICY, sdkInstalled: false };
    const v = judgeBreach(watchOnly, tx({ to: ATTACKER, amount: 150_000_000n }), {
      ...QUIET_FACTS,
      recipientFirstSeen: null,
    });
    expect(v.outcome).toBe(Outcome.COVERED);
    expect(v.payoutAmount).toBe(135_000_000n / 4n);
    expect(v.reasons.some((r) => r.tag === "PROVENANCE_UNVERIFIABLE")).toBe(true);
  });
});

// --------------------------------------------------------------------- //
//                        Determinism primitives                        //
// --------------------------------------------------------------------- //

describe("determinism", () => {
  it("sigmaDeviation is pure", () => {
    const h = QUIET_FACTS.amountHistory;
    expect(sigmaDeviation(150_000_000n, h)).toBe(sigmaDeviation(150_000_000n, h));
    expect(sigmaDeviation(5n, [1n, 1n, 1n])).toBeNull(); // insufficient data
    expect(sigmaDeviation(5n, [1n, 1n, 1n, 1n])).toBeNull(); // zero std
  });

  it("integer sqrt matches expected roots", () => {
    expect(sqrtApprox(0n)).toBe(0n);
    expect(sqrtApprox(1n)).toBe(1n);
    expect(sqrtApprox(4n)).toBe(2n);
    expect(sqrtApprox(1_000_000n)).toBe(1000n);
    expect(sqrtApprox(999_999n)).toBe(999n);
  });

  it("same inputs → same verdict, always (re-execution guarantee)", () => {
    const t = tx({ to: FRESH, amount: 900_000_000n });
    const facts = { ...QUIET_FACTS, recipientFirstSeen: null };
    const a = judgeHold(POLICY, t, facts);
    const b = judgeHold(POLICY, t, facts);
    expect(a).toEqual(b);
  });

  it("every reason carries a provenance label — nothing is INFERRED", () => {
    const v = judgeHold(POLICY, tx({ to: FRESH, amount: 900_000_000n }), {
      ...QUIET_FACTS,
      recipientFirstSeen: null,
    });
    for (const r of v.reasons) {
      expect(r.provenance === Provenance.VERIFIED || r.provenance === Provenance.COMPUTED).toBe(
        true,
      );
    }
  });
});
