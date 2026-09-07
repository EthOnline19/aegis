/**
 * BULWARK Coverage API — in-memory policy store.
 *
 * The Coverage API is the business (plan §14): platforms POST /v1/coverage
 * at agent creation; every Boa agent is born with a GuardAccount, the SDK
 * pre-installed, and name.platform.bulwark.eth records. Rev-share is
 * tracked per platform for settlement.
 */

import { quote, type DrivingRecord } from "@bulwark/engine";
import type { CoverageRequest, CoverageResponse } from "./schemas.ts";

export interface StoredPolicy {
  readonly policyId: string;
  readonly request: CoverageRequest;
  readonly response: CoverageResponse;
  readonly createdAt: number;
  readonly status: "ACTIVE" | "CANCELLED";
}

export interface PlatformAccount {
  readonly platform: string;
  readonly agentCount: number;
  readonly premiumVolume: bigint; // total monthly-equivalent written
  readonly revShareBps: number; // 2000 = 20% (plan §27)
}

const REV_SHARE_BPS = 2000;

export class CoverageStore {
  private readonly policies = new Map<string, StoredPolicy>();
  private readonly platforms = new Map<string, PlatformAccount>();
  private counter = 0;

  /** Create a policy for a platform's agent. Idempotent per agent wallet. */
  create(req: CoverageRequest, now: number): CoverageResponse {
    for (const p of this.policies.values()) {
      if (p.request.agentWallet === req.agentWallet && p.status === "ACTIVE") {
        throw new Error(`agent ${req.agentWallet} already has active coverage`);
      }
    }

    // New agents start with a clean record + KYA/SDK discounts applied.
    const record: DrivingRecord = {
      cleanStreakDays: 0,
      anomalyLoad: 0,
      attemptedBreaches: [],
      recentClaims: [],
      lifetimeClaims: 0,
      worldIdVerified: true, // platform sign-up includes World ID (KYA)
      sdkInstalled: !req.watchOnly,
      watchOnly: req.watchOnly === true,
      now,
    };
    const q = quote(record, req.policy.cap);

    const policyId = `bwk_${(++this.counter).toString(36).padStart(6, "0")}`;
    const record_ = `${req.platform}.bulwark.eth`; // ENSv2 record name (v1: derived)

    const response: CoverageResponse = {
      policyId,
      premiumStream: `${(q.multiplier * 2).toFixed(2)}%/mo-equiv`,
      record: record_,
      multiplier: q.multiplier,
      monthlyPremium: q.monthlyPremium,
    };
    this.policies.set(policyId, {
      policyId,
      request: req,
      response,
      createdAt: now,
      status: "ACTIVE",
    });

    const acct = this.platforms.get(req.platform) ?? {
      platform: req.platform,
      agentCount: 0,
      premiumVolume: 0n,
      revShareBps: REV_SHARE_BPS,
    };
    this.platforms.set(req.platform, {
      ...acct,
      agentCount: acct.agentCount + 1,
      premiumVolume: acct.premiumVolume + q.monthlyPremium,
    });

    return response;
  }

  get(policyId: string): StoredPolicy | undefined {
    return this.policies.get(policyId);
  }

  listByPlatform(platform: string): StoredPolicy[] {
    return [...this.policies.values()].filter(
      (p) => p.request.platform === platform && p.status === "ACTIVE",
    );
  }

  cancel(policyId: string, now: number): StoredPolicy {
    const p = this.policies.get(policyId);
    if (!p) throw new Error(`policy ${policyId} not found`);
    if (p.status === "CANCELLED") throw new Error("policy already cancelled");
    const cancelled: StoredPolicy = { ...p, status: "CANCELLED", createdAt: p.createdAt, response: p.response, request: p.request, policyId: p.policyId };
    void now;
    this.policies.set(policyId, { ...cancelled, status: "CANCELLED" });
    const acct = this.platforms.get(p.request.platform);
    if (acct) {
      this.platforms.set(p.request.platform, {
        ...acct,
        agentCount: acct.agentCount - 1,
        premiumVolume: acct.premiumVolume - p.response.monthlyPremium,
      });
    }
    return this.policies.get(policyId)!;
  }

  /** Fleet dashboard data (plan §27): live actuarial tables per platform. */
  platformStats(platform: string): PlatformAccount | undefined {
    return this.platforms.get(platform);
  }
}
