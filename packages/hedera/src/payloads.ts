/**
 * REPAYD x402 Payloads — the paid content of the Coverage & Risk API.
 *
 * Deterministic, honest data: the quote is the real pricing engine run on a
 * fixed driving record; the verdict record mirrors the ERC-8004 registry
 * readback from the verified Step-4 Arc testnet run; the résumé is the real
 * ENSv2 résumé builder. Same inputs, same outputs, forever.
 */

import { quote, type DrivingRecord, type Reason } from "@bulwark/engine";
import { buildResume, renderResume, type ResumeInput } from "@bulwark/record";

/** The canonical ERC-8004 agent identity from the verified Step-4 run. */
export const ERC8004_AGENT_ID = 894341n;
export const ERC8004_AGENT_OWNER = "0x05499b0be3B9E9Db3Cc5124b2F682513D94133A6";
export const ERC8004_AGENT_WALLET = "0x9675b4D20d2ACFE55D00a02D55B9cdb57AEbD482";

/** The accepted covered verdict from the Step-4 run (registry-verified). */
export const STEP4_VERDICT_DIGEST =
  "0x1af03bc6a70b6309bd5c9ec92c7d78c1024e0d69c9ea5ea60faf828c958ed3f0";

/**
 * The Step-4 driving record: what the verified run actually produced.
 * One covered claim ($135 payout, 2026-09-11), fresh streak since.
 */
const STEP4_EPOCH = 1_789_161_217; // lastUpdate of the validation readback

export function step4DrivingRecord(now: number): DrivingRecord {
  return {
    cleanStreakDays: 1,
    anomalyLoad: 0.05,
    attemptedBreaches: [], // the $900 OVER_PER_TX block was pre-broadcast, not an on-chain attempt
    recentClaims: [STEP4_EPOCH],
    lifetimeClaims: 1,
    worldIdVerified: true,
    sdkInstalled: true,
    watchOnly: false,
    now,
  };
}

/** Default coverage cap: the Step-4 pool-grade policy, $2,500. */
export const DEFAULT_COVERAGE_CAP = 2_500_000_000n; // USDC 6dp

/** The quote payload: GET /v1/x402/quote?agent=<evm-addr> */
export interface QuotePayload {
  readonly kind: "repayd.quote";
  readonly agent: string;
  readonly agentId: string;
  readonly coverageCap: string; // USDC base units
  readonly multiplier: number;
  readonly monthlyPremium: string; // USDC base units
  readonly premiumLabel: string; // e.g. "0.31%/mo-equiv"
  readonly reasons: readonly Reason[];
  readonly computedAt: number;
}

export function buildQuotePayload(agent: string, now: number): QuotePayload {
  const q = quote(step4DrivingRecord(now), DEFAULT_COVERAGE_CAP);
  return {
    kind: "repayd.quote",
    agent: agent.toLowerCase(),
    agentId: ERC8004_AGENT_ID.toString(),
    coverageCap: DEFAULT_COVERAGE_CAP.toString(),
    multiplier: q.multiplier,
    monthlyPremium: q.monthlyPremium.toString(),
    premiumLabel: `${(q.multiplier * 2).toFixed(2)}%/mo-equiv`,
    reasons: q.reasons,
    computedAt: now,
  };
}

/** The verdict-record payload: GET /v1/x402/verdicts/<digest> */
export interface VerdictRecordPayload {
  readonly kind: "repayd.verdict-record";
  readonly digest: string;
  readonly chain: "arc-testnet-5042002";
  readonly erc8004: {
    readonly standard: "ERC-8004";
    readonly agentId: string;
    readonly identityRegistry: string;
    readonly validationRegistry: string;
    readonly reputationRegistry: string;
    readonly validation: {
      readonly requestHash: string;
      readonly validatorAddress: string;
      readonly response: number; // 25 = SCORE_COVERED
      readonly responseHash: string;
      readonly tag: string;
      readonly lastUpdate: number;
    };
    readonly feedback: {
      readonly value: number; // −2500 @ 2dp = −$25.00 net premium effect
      readonly valueDecimals: number;
      readonly tag1: string;
      readonly tag2: string;
      readonly isRevoked: boolean;
    };
  };
  readonly verdict: {
    readonly outcome: "COVERED";
    readonly payoutUsdc: string; // base units
    readonly payoutLabel: string;
    readonly verdictTx: string;
    readonly arcscanUrl: string;
  };
  readonly mirrors: {
    readonly subgraph: string; // REPAYD Risk Subgraph entity id
    readonly hederaAuditTopic: string | null; // set when HCS receipt exists
  };
}

/** The one verdict the service serves — from the verified Step-4 readback. */
export function buildVerdictRecordPayload(
  digest: string,
  hederaAuditTopic: string | null,
): VerdictRecordPayload {
  if (digest.toLowerCase() !== STEP4_VERDICT_DIGEST) {
    throw new Error(`unknown digest: ${digest}`);
  }
  return {
    kind: "repayd.verdict-record",
    digest: STEP4_VERDICT_DIGEST,
    chain: "arc-testnet-5042002",
    erc8004: {
      standard: "ERC-8004",
      agentId: ERC8004_AGENT_ID.toString(),
      identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
      reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      validation: {
        requestHash:
          "0xb8f6cd18e05b55f3f7af37404c93067df808d4c03c3cce6e2e00a100b2c862cf",
        validatorAddress: "0xAfB732d3C1B483b9e2Cdf9f2c3A2438ABeb2bEDa",
        response: 25,
        responseHash: STEP4_VERDICT_DIGEST,
        tag: "bulwark-verdict",
        lastUpdate: STEP4_EPOCH,
      },
      feedback: {
        value: -2500,
        valueDecimals: 2,
        tag1: "bulwark-verdict",
        tag2: "covered",
        isRevoked: false,
      },
    },
    verdict: {
      outcome: "COVERED",
      payoutUsdc: "135000000",
      payoutLabel: "$135.00",
      verdictTx:
        "0xed020f97235164333e416ae494c6b24462a6884e1aa2ba1a1898b85d07a299f6",
      arcscanUrl:
        "https://testnet.arcscan.app/tx/0xed020f97235164333e416ae494c6b24462a6884e1aa2ba1a1898b85d07a299f6",
    },
    mirrors: {
      subgraph: `verdict:${STEP4_VERDICT_DIGEST}`,
      hederaAuditTopic,
    },
  };
}

/** The résumé payload: GET /v1/x402/resume/<ens> */
export interface ResumePayload {
  readonly kind: "repayd.resume";
  readonly ens: string;
  readonly ensTextRecords: Record<string, string>;
  readonly block: string; // the rendered §13 terminal block
  readonly fields: readonly { key: string; text: string; provenance: string }[];
}

/** The Step-4 résumé input — the same facts the record builder consumes. */
export function buildResumePayload(ens: string): ResumePayload {
  const input: ResumeInput = {
    policy: { version: 1, capUsd: 2500, poolHealthy: true },
    driving: { cleanDays: 1, score: 100 },
    claims: { covered: 1, attempted: 1, payoutsUsd: [135] },
    alibi: { installed: true, instructionChainLive: true },
    backing: { worldIdVerified: true },
    status: "ACTIVE since 2026-09-11",
  };
  const resume = buildResume(input);
  return {
    kind: "repayd.resume",
    ens,
    ensTextRecords: Object.fromEntries(
      Object.entries(resume).map(([key, field]) => [key, `${field.text} [${field.provenance}]`]),
    ),
    block: renderResume(resume),
    fields: Object.values(resume).map((f) => ({
      key: f.key,
      text: f.text,
      provenance: f.provenance,
    })),
  };
}
