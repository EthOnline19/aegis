import { describe, expect, it } from "bun:test";

/**
 * Challenge/response tests against the REAL @x402/express middleware stack:
 * paymentMiddleware → x402ResourceServer → ExactHederaScheme(@x402/hedera)
 * → HTTPFacilitatorClient, with the Blocky402 facilitator replaced by an
 * in-process mock (verify/settle/supported).
 *
 * Wire facts (verified against @x402/core 2.25.0 dist):
 *  - 402 carries base64 JSON `PAYMENT-REQUIRED` header (x402Version 2).
 *  - The client retry header for v2 is `PAYMENT-SIGNATURE` (express lookup is
 *    case-insensitive; the x402 client lib emits PAYMENT-SIGNATURE for v2 and
 *    X-PAYMENT for v1).
 *  - Settlement echoes back on `PAYMENT-RESPONSE`.
 */

// Distinct from the live demo service (:4601) so the suite is hermetic while
// the demo runs; env-overridable for CI.
const MOCK_FACILITATOR_PORT = Number(process.env.TEST_FACILITATOR_PORT ?? 4712);
const SERVICE_PORT = Number(process.env.TEST_SERVICE_PORT ?? 4711);
const PAY_TO = "0.0.10484593";
const AGENT = "0x05499b0be3B9E9Db3Cc5124b2F682513D94133A6";

/** Mock facilitator: /supported, /verify (isValid unless payload.invalid), /settle. */
Bun.serve({
  port: MOCK_FACILITATOR_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/supported") {
      return Response.json({
        kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.7162784" } }],
        extensions: [],
        signers: { "hedera:testnet": ["0.0.7162784"] },
      });
    }
    if (url.pathname === "/verify") {
      const body = (await req.json()) as { paymentPayload: { payload: Record<string, unknown> } };
      const invalid = body.paymentPayload?.payload?.invalid === true;
      return Response.json(
        invalid
          ? { isValid: false, invalidReason: "invalid_exact_hedera_payload_signature_invalid" }
          : { isValid: true, payer: "0.0.10484477" },
      );
    }
    if (url.pathname === "/settle") {
      return Response.json({
        success: true,
        transaction: "0.0.10484477@1789161300.000000001",
        network: "hedera:testnet",
        payer: "0.0.10484477",
      });
    }
    return new Response("not found", { status: 404 });
  },
});

process.env.X402_FACILITATOR_URL = `http://localhost:${MOCK_FACILITATOR_PORT}`;
process.env.REPAYD_X402_PORT = String(SERVICE_PORT);
process.env.HEDERA_SERVICE_ID = PAY_TO;

// Importing boots the real service (app.listen) on SERVICE_PORT.
await import("../src/server.ts");

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function paymentPayload(invalid = false): string {
  return b64({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "hedera:testnet",
      amount: "100000",
      asset: "0.0.0",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { feePayer: "0.0.7162784" },
    },
    payload: invalid ? { invalid: true } : { tx: "mock-signed-transfer" },
  });
}

const QUOTE_URL = `http://localhost:${SERVICE_PORT}/v1/x402/quote?agent=${AGENT}&agentId=894341`;

describe("x402 challenge/response (real middleware, mocked facilitator)", () => {
  it("free discovery endpoint needs no payment", async () => {
    const res = await fetch(`http://localhost:${SERVICE_PORT}/v1/x402/services`);
    expect(res.status).toBe(200);
    const dir = (await res.json()) as { payTo: string; endpoints: unknown[] };
    expect(dir.payTo).toBe(PAY_TO);
    expect(dir.endpoints).toHaveLength(3);
  });

  it("unpaid request → 402 with PAYMENT-REQUIRED requirements header", async () => {
    const res = await fetch(QUOTE_URL);
    expect(res.status).toBe(402);
    const required = res.headers.get("payment-required");
    expect(required).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(required!, "base64").toString("utf8")) as {
      x402Version: number;
      accepts: {
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
        extra: Record<string, unknown>;
      }[];
    };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
    const opt = decoded.accepts[0]!;
    expect(opt.scheme).toBe("exact");
    expect(opt.network).toBe("hedera:testnet");
    expect(opt.amount).toBe("100000"); // quote price in tinybars
    expect(opt.asset).toBe("0.0.0"); // native HBAR
    expect(opt.payTo).toBe(PAY_TO);
    expect(opt.extra.feePayer).toBe("0.0.7162784"); // facilitator is fee-payer
  });

  it("X-PAYMENT retry (PAYMENT-SIGNATURE, v2) with a valid payload → 200 + settlement", async () => {
    const res = await fetch(QUOTE_URL, {
      headers: { "payment-signature": paymentPayload(false) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; pricePaid: string };
    expect(body.kind).toBe("repayd.quote");
    expect(body.pricePaid).toBe("0.001 HBAR");
    const settlement = res.headers.get("payment-response");
    expect(settlement).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(settlement!, "base64").toString("utf8")) as {
      success: boolean;
      transaction: string;
    };
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toContain("0.0.10484477@");
  });

  it("facilitator verify-invalid → re-402 (no content served)", async () => {
    const res = await fetch(QUOTE_URL, {
      headers: { "payment-signature": paymentPayload(true) },
    });
    expect(res.status).toBe(402);
    const required = res.headers.get("payment-required");
    expect(required).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(required!, "base64").toString("utf8")) as { error: string };
    expect(decoded.error).toContain("invalid_exact_hedera_payload_signature_invalid");
  });

  it("meter counts only served (paid) calls", async () => {
    const health = await fetch(`http://localhost:${SERVICE_PORT}/healthz`);
    const snap = (await health.json()) as { meter: { servedCalls: Record<string, number>; totalBilledTinybars: string } };
    expect(snap.meter.servedCalls.quote).toBeGreaterThanOrEqual(1);
    expect(Number(snap.meter.totalBilledTinybars)).toBeGreaterThanOrEqual(100_000);
  });
});
