import { describe, expect, it } from "bun:test";

import {
  ENDPOINT_PRICING,
  assetAmount,
  priceLabel,
  CallMeter,
  TINYBARS_PER_HBAR,
} from "../src/pricing-meter.ts";
import {
  buildQuotePayload,
  buildVerdictRecordPayload,
  buildResumePayload,
  STEP4_VERDICT_DIGEST,
  ERC8004_AGENT_ID,
} from "../src/payloads.ts";
import { buildReceiptMemo, dryRunRecorder } from "../src/hcs.ts";
import { pinnedIdentityValidator } from "../src/identity.ts";

const NOW = 1_789_161_300;
const AGENT = "0x05499b0be3B9E9Db3Cc5124b2F682513D94133A6";

describe("per-endpoint pricing (fee schedule)", () => {
  it("carries the documented tinybar prices", () => {
    expect(ENDPOINT_PRICING.quote.priceTinybars).toBe(100_000n); // 0.001 HBAR
    expect(ENDPOINT_PRICING.verdicts.priceTinybars).toBe(200_000n); // 0.002 HBAR
    expect(ENDPOINT_PRICING.resume.priceTinybars).toBe(150_000n); // 0.0015 HBAR
  });

  it("prices are native-HBAR AssetAmounts (asset 0.0.0)", () => {
    for (const id of ["quote", "verdicts", "resume"] as const) {
      const a = assetAmount(id);
      expect(a.asset).toBe("0.0.0");
      expect(a.amount).toBe(ENDPOINT_PRICING[id].priceTinybars.toString());
      expect(priceLabel(id)).toMatch(/HBAR$/);
    }
  });

  it("tinybar scale is consistent (1 HBAR = 10^8 tinybars)", () => {
    expect(TINYBARS_PER_HBAR).toBe(100_000_000n);
  });
});

describe("call meter (pay-per-call metering)", () => {
  it("counts served calls and billed tinybars per endpoint", () => {
    const meter = new CallMeter();
    meter.record("quote");
    meter.record("quote");
    meter.record("resume");
    const snap = meter.snapshot();
    expect(snap.counts).toEqual({ quote: 2, verdicts: 0, resume: 1 });
    expect(snap.billedTinybars.quote).toBe(200_000n);
    expect(snap.billedTinybars.resume).toBe(150_000n);
    expect(snap.totalTinybars).toBe(350_000n);
  });

  it("starts at zero and never under-counts", () => {
    const meter = new CallMeter();
    expect(meter.snapshot().totalTinybars).toBe(0n);
    meter.record("verdicts");
    expect(meter.snapshot().counts.verdicts).toBe(1);
  });
});

describe("directory payload shape (GET /v1/x402/services)", () => {
  it("advertises every metered endpoint with method, description, price", () => {
    const endpoints = Object.values(ENDPOINT_PRICING).map((e) => ({
      id: e.id,
      route: e.route,
      method: "GET",
      description: e.description,
      mimeType: e.mimeType,
      price: `${priceLabel(e.id)} (${e.priceTinybars} tinybars)`,
    }));
    expect(endpoints).toHaveLength(3);
    for (const e of endpoints) {
      expect(e.method).toBe("GET");
      expect(e.route).toMatch(/^\/v1\/x402\//);
      expect(e.price).toMatch(/\d+ tinybars\)$/);
    }
    expect(endpoints.map((e) => e.id).sort()).toEqual(["quote", "resume", "verdicts"]);
  });
});

describe("402 challenge payload facts", () => {
  it("quote payload is deterministic and ERC-8004-stamped", () => {
    const a = buildQuotePayload(AGENT, NOW);
    const b = buildQuotePayload(AGENT.toUpperCase(), NOW);
    expect(a).toEqual(b); // same record + cap → identical quote
    expect(a.kind).toBe("repayd.quote");
    expect(a.agentId).toBe(ERC8004_AGENT_ID.toString());
    expect(a.monthlyPremium).toMatch(/^\d+$/);
  });

  it("verdict record mirrors the Step-4 registry readback", () => {
    const v = buildVerdictRecordPayload(STEP4_VERDICT_DIGEST, null);
    expect(v.verdict.outcome).toBe("COVERED");
    expect(v.verdict.payoutUsdc).toBe("135000000");
    expect(v.erc8004.validation.response).toBe(25);
    expect(v.erc8004.validation.tag).toBe("bulwark-verdict");
    expect(v.erc8004.feedback.tag2).toBe("covered");
    expect(v.mirrors.hederaAuditTopic).toBeNull();
  });

  it("rejects unknown digests — only the served verdict exists", () => {
    expect(() => buildVerdictRecordPayload("0x" + "00".repeat(32), null)).toThrow(/unknown digest/);
  });

  it("resume block is a real rendered résumé with provenance", () => {
    const r = buildResumePayload("amara.repayd.eth");
    expect(r.kind).toBe("repayd.resume");
    expect(r.block.length).toBeGreaterThan(0);
    expect(r.fields.length).toBeGreaterThan(0);
    for (const f of r.fields) {
      expect(["VERIFIED", "COMPUTED", "verified", "computed"]).toContain(f.provenance);
    }
  });
});

describe("HCS audit memo + dry-run recorder", () => {
  it("builds the receipt memo with pinned facts", () => {
    const memo = buildReceiptMemo({
      tx: "0.0.10484477@1789161300.000000001",
      network: "hedera:testnet",
      endpoint: "quote",
      price: "100000",
      agentId: ERC8004_AGENT_ID.toString(),
      identityVerified: true,
      now: NOW,
    });
    expect(memo.kind).toBe("repayd.x402-receipt");
    expect(memo.ts).toBe(NOW);
    expect(memo.identityVerified).toBe(true);
    expect(JSON.parse(JSON.stringify(memo)).tx).toContain("10484477");
  });

  it("dry-run recorder claims nothing and logs the memo", async () => {
    const rec = dryRunRecorder(null);
    const result = await rec.record(
      buildReceiptMemo({
        tx: "pending-settlement:GET:/v1/x402/quote:1",
        network: "hedera:testnet",
        endpoint: "quote",
        price: "100000",
        agentId: null,
        identityVerified: false,
        now: NOW,
      }),
    );
    expect(result.submitted).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.submitTx).toBeNull();
  });
});

describe("identity validation (pinned Step-4 facts)", () => {
  it("verifies the canonical agentId", async () => {
    const status = await pinnedIdentityValidator().validate(ERC8004_AGENT_ID.toString());
    expect(status.status).toBe("verified");
    if (status.status === "verified") {
      expect(status.owner.toLowerCase()).toBe("0x05499b0be3b9e9db3cc5124b2f682513d94133a6");
      expect(status.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("rejects unknown agentIds", async () => {
    const status = await pinnedIdentityValidator().validate("999999");
    expect(status).toEqual({ status: "unverified", reason: expect.stringContaining("unknown agentId") });
  });
});
