/**
 * REPAYD x402 Coverage & Risk API — the service.
 *
 * A live x402-gated resource server on HTTP: three pay-per-call endpoints
 * (risk quote, ERC-8004 verdict record, agent résumé) behind the x402
 * `exact` scheme on `hedera:testnet`, verified and settled through the
 * Blocky402 facilitator (https://api.testnet.blocky402.com — open access).
 *
 * Payment handling is the official @x402 middleware stack:
 *   paymentMiddleware(@x402/express) → x402ResourceServer(@x402/core)
 *   → ExactHederaScheme(@x402/hedera) → HTTPFacilitatorClient(Blocky402).
 *
 * The service never touches a private key: the facilitator is the fee-payer
 * and settler; the service's own HCS audit trail is separately gated.
 */

import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  CallMeter,
  ENDPOINT_PRICING,
  assetAmount,
  priceLabel,
} from "./pricing-meter.ts";
import {
  buildQuotePayload,
  buildVerdictRecordPayload,
  buildResumePayload,
  STEP4_VERDICT_DIGEST,
  ERC8004_AGENT_ID,
} from "./payloads.ts";
import { arcIdentityValidator, pinnedIdentityValidator, type IdentityValidator, type IdentityStatus } from "./identity.ts";
import { buildReceiptMemo, dryRunRecorder, liveRecorder, type ReceiptRecorder } from "./hcs.ts";

// ---------------------------------------------------------------------------
// Config (dry-run default: no key, no chain writes from the service itself)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.REPAYD_X402_PORT ?? "4021", 10);
const PAY_TO = process.env.HEDERA_SERVICE_ID ?? "0.0.UNSET";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";
const NETWORK = "hedera:testnet" as const;
const ASSET = "0.0.0"; // native HBAR

const SERVICE_KEY = process.env.HEDERA_SERVICE_KEY ?? "";
const RECEIPT_TOPIC = process.env.HEDERA_RECEIPT_TOPIC_ID ?? "";
const ARC_RPC = process.env.ARC_RPC_URL ?? "";

const meter = new CallMeter();

// Identity: live read-only validation against the Arc registry when an RPC is
// configured; pinned Step-4 facts otherwise. Never a paywall gate.
const identity: IdentityValidator = ARC_RPC ? arcIdentityValidator(ARC_RPC) : pinnedIdentityValidator();

// HCS audit: dry-run unless the service key is present.
let recorder: ReceiptRecorder = dryRunRecorder(RECEIPT_TOPIC || null);
let hcsLive = false;
if (SERVICE_KEY && process.env.HEDERA_NETWORK === "testnet") {
  liveRecorder(PAY_TO, SERVICE_KEY, RECEIPT_TOPIC || null)
    .then((r) => {
      recorder = r;
      hcsLive = true;
    })
    .catch((err) => {
      console.warn(`[hcs] live recorder unavailable, staying in dry-run: ${String(err)}`);
    });
}
// ---------------------------------------------------------------------------
// x402 resource server: Blocky402 facilitator + Hedera exact scheme
// ---------------------------------------------------------------------------

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitator).register(
  "hedera:*",
  new ExactHederaScheme({}),
);

// ---------------------------------------------------------------------------
// Route table (the fee schedule, advertised in every 402)
// ---------------------------------------------------------------------------

function accepts(endpoint: "quote" | "verdicts" | "resume") {
  return [
    {
      scheme: "exact" as const,
      network: NETWORK,
      price: assetAmount(endpoint),
      payTo: PAY_TO,
      description: ENDPOINT_PRICING[endpoint].description,
      mimeType: ENDPOINT_PRICING[endpoint].mimeType,
      maxTimeoutSeconds: 60,
    },
  ];
}

// ---------------------------------------------------------------------------
// Paid endpoints
// ---------------------------------------------------------------------------

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /v1/x402/quote": {
        accepts: accepts("quote"),
        description: ENDPOINT_PRICING.quote.description,
        mimeType: "application/json",
      },
      "GET /v1/x402/verdicts/*": {
        accepts: accepts("verdicts"),
        description: ENDPOINT_PRICING.verdicts.description,
        mimeType: "application/json",
      },
      "GET /v1/x402/resume/*": {
        accepts: accepts("resume"),
        description: ENDPOINT_PRICING.resume.description,
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/v1/x402/quote", async (req, res) => {
  const agent = typeof req.query["agent"] === "string" ? req.query["agent"] : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent)) {
    res.status(400).json({ error: "query param `agent` must be a 0x-prefixed 20-byte address" });
    return;
  }
  const agentId = typeof req.query["agentId"] === "string" ? req.query["agentId"] : ERC8004_AGENT_ID.toString();
  const idStatus: IdentityStatus = await identity.validate(agentId);

  const payload = buildQuotePayload(agent, Math.floor(Date.now() / 1000));
  meter.record("quote");
  await audit(req, "quote", idStatus);
  res.json({ ...payload, identity: idStatus, pricePaid: priceLabel("quote") });
});

app.get("/v1/x402/verdicts/:digest", async (req, res) => {
  const digest = String(req.params["digest"] ?? "");
  if (digest.toLowerCase() !== STEP4_VERDICT_DIGEST) {
    res.status(404).json({ error: `no verdict record for digest ${digest}` });
    return;
  }
  const payload = buildVerdictRecordPayload(digest, RECEIPT_TOPIC || null);
  meter.record("verdicts");
  await audit(req, "verdicts");
  res.json({ ...payload, pricePaid: priceLabel("verdicts") });
});

app.get("/v1/x402/resume/:ens", async (req, res) => {
  const ens = String(req.params["ens"] ?? "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ens)) {
    res.status(400).json({ error: "path segment must be an ENS name, e.g. amara.repayd.eth" });
    return;
  }
  const payload = buildResumePayload(ens);
  meter.record("resume");
  await audit(req, "resume");
  res.json({ ...payload, pricePaid: priceLabel("resume") });
});

// ---------------------------------------------------------------------------
// Free endpoints: discovery directory + health
// ---------------------------------------------------------------------------

/** The discovery directory — how payer agents find the service and its prices. */
app.get("/v1/x402/services", (_req, res) => {
  res.json({
    kind: "repayd.x402-directory",
    service: "REPAYD Coverage & Risk API",
    network: NETWORK,
    scheme: "exact",
    asset: ASSET,
    payTo: PAY_TO,
    facilitator: FACILITATOR_URL,
    identity: { standard: "ERC-8004", chain: "arc-testnet-5042002", agentId: ERC8004_AGENT_ID.toString() },
    endpoints: Object.values(ENDPOINT_PRICING).map((e) => ({
      id: e.id,
      route: e.route,
      method: "GET",
      description: e.description,
      mimeType: e.mimeType,
      price: `${priceLabel(e.id)} (${e.priceTinybars} tinybars)`,
    })),
  });
});

app.get("/healthz", (_req, res) => {
  const snap = meter.snapshot();
  res.json({
    status: "ok",
    facilitator: FACILITATOR_URL,
    network: NETWORK,
    payTo: PAY_TO,
    hcsAudit: hcsLive ? "live" : "dry-run",
    meter: {
      servedCalls: snap.counts,
      billedTinybars: Object.fromEntries(
        Object.entries(snap.billedTinybars).map(([k, v]) => [k, v.toString()]),
      ),
      totalBilledTinybars: snap.totalTinybars.toString(),
    },
  });
});

// ---------------------------------------------------------------------------
// HCS audit hook — called after a paid response is about to be served.
// In live mode the settlement tx id arrives on the response headers via the
// middleware; in dry-run we log the memo with the request id as reference.
// ---------------------------------------------------------------------------

async function audit(
  req: express.Request,
  endpoint: "quote" | "verdicts" | "resume",
  idStatus?: IdentityStatus,
): Promise<void> {
  // The @x402/express middleware settles after the response is sent; the
  // settlement transaction id is not yet available at handler time. The
  // audit memo therefore references the paid request (endpoint + price +
  // identity); once the middleware exposes the settlement via the response
  // PAYMENT-RESPONSE header, the payer cross-links it on HashScan.
  const memo = buildReceiptMemo({
    tx: `pending-settlement:${req.method}:${req.path}:${Date.now()}`,
    network: NETWORK,
    endpoint,
    price: ENDPOINT_PRICING[endpoint].priceTinybars.toString(),
    agentId:
      (typeof req.query["agentId"] === "string" ? req.query["agentId"] : null) ??
      ERC8004_AGENT_ID.toString(),
    identityVerified: idStatus?.status === "verified",
  });
  try {
    await recorder.record(memo);
  } catch (err) {
    console.warn(`[hcs] audit failed (non-fatal): ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (PAY_TO === "0.0.UNSET") {
  console.warn(
    "⚠ HEDERA_SERVICE_ID not set — payment challenges will advertise payTo=0.0.UNSET.\n" +
      "  Set it to the service's Hedera testnet account (the x402 payTo) before going live.",
  );
}

app.listen(PORT, () => {
  console.log(`\n⚡ REPAYD x402 Coverage & Risk API on http://localhost:${PORT}`);
  console.log(`   Network: ${NETWORK} (asset ${ASSET}, native HBAR)`);
  console.log(`   Facilitator: ${FACILITATOR_URL} (Blocky402, open access)`);
  console.log(`   Pay to: ${PAY_TO}`);
  for (const e of Object.values(ENDPOINT_PRICING)) {
    console.log(`   ${e.route} — ${priceLabel(e.id)}`);
  }
  console.log(`   Directory: http://localhost:${PORT}/v1/x402/services (free)`);
  console.log(`   HCS audit: ${SERVICE_KEY && process.env.HEDERA_NETWORK === "testnet" ? "live" : "dry-run"}\n`);
});
