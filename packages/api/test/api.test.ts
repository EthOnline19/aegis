import { describe, expect, it } from "vitest";

import { parseCoverageRequest } from "../src/schemas.ts";
import { CoverageStore } from "../src/store.ts";

const NOW = 1_772_000_000;

const VALID = {
  agentWallet: "0x" + "11".repeat(20),
  platform: "boa-host-7",
  policy: {
    cap: 5_000_000_000, // $5,000
    perTx: 300_000_000, // $300
    daily: 1_000_000_000,
    velocity: 10,
    allowlist: ["0x" + "22".repeat(20)],
  },
};

describe("schema validation", () => {
  it("parses a valid request with defaults", () => {
    const parsed = parseCoverageRequest(VALID);
    expect(parsed.policy.deductibleBps).toBe(1000); // 10% default
    expect(parsed.policy.holdWindowSec).toBe(120); // 2-min default
    expect(parsed.watchOnly).toBe(false);
  });

  it("rejects a malformed wallet address", () => {
    expect(() => parseCoverageRequest({ ...VALID, agentWallet: "0x123" })).toThrow(/agentWallet/);
  });

  it("rejects daily < perTx", () => {
    expect(() =>
      parseCoverageRequest({
        ...VALID,
        policy: { ...VALID.policy, daily: 100, perTx: 200 },
      }),
    ).toThrow(/daily/);
  });

  it("rejects perTx above cap", () => {
    expect(() =>
      parseCoverageRequest({
        ...VALID,
        policy: { ...VALID.policy, cap: 100, perTx: 200 },
      }),
    ).toThrow(/perTx/);
  });

  it("rejects non-address allowlist entries", () => {
    expect(() =>
      parseCoverageRequest({
        ...VALID,
        policy: { ...VALID.policy, allowlist: ["not-an-address"] },
      }),
    ).toThrow(/allowlist/);
  });

  it("rejects out-of-range deductible", () => {
    expect(() =>
      parseCoverageRequest({
        ...VALID,
        policy: { ...VALID.policy, deductibleBps: 9001 },
      }),
    ).toThrow(/deductible/);
  });

  it("rejects non-object bodies", () => {
    expect(() => parseCoverageRequest(null)).toThrow();
    expect(() => parseCoverageRequest("hi")).toThrow();
    expect(() => parseCoverageRequest(42)).toThrow();
  });
});

describe("coverage store (the business)", () => {
  it("Case 12: Boa creates a policy → 201-shaped quote with record name", () => {
    const store = new CoverageStore();
    const res = store.create(parseCoverageRequest(VALID), NOW);
    expect(res.policyId).toMatch(/^bwk_/);
    expect(res.record).toBe("boa-host-7.bulwark.eth");
    // New agent, KYA + SDK discounts: 0.72x.
    expect(res.multiplier).toBeCloseTo(0.72, 5);
    expect(res.monthlyPremium).toBeGreaterThan(0n);
  });

  it("watch-only policies carry the ×2 load", () => {
    const store = new CoverageStore();
    const res = store.create(parseCoverageRequest({ ...VALID, watchOnly: true }), NOW);
    // 0.8 KYA × 2 watch-only = 1.6x (no SDK discount — none installed).
    expect(res.multiplier).toBeCloseTo(1.6, 5);
  });

  it("rejects duplicate active coverage per agent", () => {
    const store = new CoverageStore();
    store.create(parseCoverageRequest(VALID), NOW);
    expect(() => store.create(parseCoverageRequest(VALID), NOW + 1)).toThrow(/already has active/);
  });

  it("platform stats accumulate agents and rev-share volume", () => {
    const store = new CoverageStore();
    store.create(parseCoverageRequest(VALID), NOW);
    store.create(
      parseCoverageRequest({
        ...VALID,
        agentWallet: "0x" + "33".repeat(20),
        policy: { ...VALID.policy, cap: 1_000_000_000, perTx: 100_000_000, daily: 500_000_000 },
      }),
      NOW,
    );

    const stats = store.platformStats("boa-host-7");
    expect(stats?.agentCount).toBe(2);
    expect(stats?.revShareBps).toBe(2000); // 20% (plan §27)

    const fleet = store.listByPlatform("boa-host-7");
    expect(fleet.length).toBe(2);
  });

  it("cancel frees the agent for re-coverage and decrements the platform", () => {
    const store = new CoverageStore();
    const res = store.create(parseCoverageRequest(VALID), NOW);
    store.cancel(res.policyId, NOW + 60);

    expect(store.get(res.policyId)?.status).toBe("CANCELLED");
    expect(store.platformStats("boa-host-7")?.agentCount).toBe(0);

    // Re-coverage now allowed.
    const again = store.create(parseCoverageRequest(VALID), NOW + 120);
    expect(again.policyId).not.toBe(res.policyId);
  });
});
