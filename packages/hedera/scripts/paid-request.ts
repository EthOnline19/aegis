/**
 * REPAYD payer agent — one REAL paid x402 request end-to-end.
 *
 * Flow (see docs/submission/hedera-x402-plan.md §3):
 *   1. GET  /v1/x402/services        — free discovery directory
 *   2. GET  paid endpoint            — 402 + PAYMENT-REQUIRED (requirements)
 *   3. x402 client builds + signs the Hedera TransferTransaction (payer key)
 *      and retries with X-PAYMENT (facilitator is fee-payer — no gas needed)
 *   4. Blocky402 facilitator verifies → service serves → settles on testnet
 *   5. 200 + payload + PAYMENT-RESPONSE (settlement tx id) → HashScan link
 *
 * Dry-run default: without HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY the script
 * prints the exact flow it would execute with real numbers and exits 0.
 * Set HEDERA_OPERATOR_ID + HEDERA_OPERATOR_KEY (+ optional REPAYD_SERVICE_URL,
 * default http://localhost:4021) to execute the live paid request.
 */

import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";

const SERVICE_URL = process.env.REPAYD_SERVICE_URL ?? "http://localhost:4021";
const OPERATOR_ID = process.env.HEDERA_OPERATOR_ID ?? "";
const OPERATOR_KEY = process.env.HEDERA_OPERATOR_KEY ?? "";

interface DirectoryEndpoint {
  id: string;
  route: string;
  method: string;
  description: string;
  price: string;
}

async function main(): Promise<void> {
  console.log(`⚡ REPAYD payer agent → ${SERVICE_URL}`);

  // 1. Discovery (free) — how an agent finds the service and its fee schedule.
  const dirRes = await fetch(`${SERVICE_URL}/v1/x402/services`);
  const dir = (await dirRes.json()) as {
    network: string;
    scheme: string;
    payTo: string;
    facilitator: string;
    endpoints: DirectoryEndpoint[];
  };
  console.log(`[1] discovery: ${dir.endpoints.length} metered endpoints, network=${dir.network}, payTo=${dir.payTo}`);
  for (const e of dir.endpoints) console.log(`    ${e.route} — ${e.price}`);

  // Pick the cheapest metered endpoint for the demo paid call: the risk quote.
  const quote = dir.endpoints.find((e) => e.id === "quote");
  if (!quote) throw new Error("directory has no quote endpoint");
  const paidUrl = `${SERVICE_URL}${quote.route}?agent=0x05499b0be3B9E9Db3Cc5124b2F682513D94133A6&agentId=894341`;

  // Dry-run default: print the exact flow with the real numbers, don't sign.
  if (!OPERATOR_ID || !OPERATOR_KEY) {
    console.log("\n[DRY-RUN] HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set — no signature, no chain write.");
    console.log("  Would execute (live path when keys are set):");
    console.log(`  [2] GET ${paidUrl}`);
    console.log(`      ← 402 PAYMENT-REQUIRED: scheme=exact network=${dir.network}`);
    console.log(`        amount=${quote.price} asset=0.0.0 (native HBAR) payTo=${dir.payTo}`);
    console.log(`        extra.feePayer=<facilitator account — the payer needs no gas>`);
    console.log(`  [3] client signs TransferTransaction(${quote.price} tinybars → ${dir.payTo})`);
    console.log(`        with HEDERA_OPERATOR_KEY (ECDSA); retries with X-PAYMENT header`);
    console.log(`  [4] POST ${dir.facilitator}/verify → isValid`);
    console.log(`      POST ${dir.facilitator}/settle → facilitator co-signs + submits to Hedera testnet`);
    console.log(`  [5] ← 200 payload + PAYMENT-RESPONSE (settlement tx id)`);
    console.log(`      → https://hashscan.io/testnet/tx/<transactionId>`);
    console.log(`      → HCS receipt memo (endpoint, price, agentId 894341) on the audit topic`);
    return;
  }

  // Live path: real keys — complete the actual paid request.
  const signer = createClientHederaSigner(OPERATOR_ID, PrivateKey.fromStringECDSA(OPERATOR_KEY));
  const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  console.log(`\n[2] paying ${quote.price} for GET ${paidUrl}`);
  const res = await fetchWithPay(paidUrl);
  const settlementTx = res.headers.get("payment-response");
  const body = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    console.error(`paid request failed: HTTP ${res.status}`, body);
    process.exit(1);
  }

  console.log(`[3] 200 OK — paid payload received:`);
  console.log(JSON.stringify(body, null, 2));
  if (settlementTx) {
    console.log(`[4] settlement tx: ${settlementTx}`);
    console.log(`    https://hashscan.io/testnet/tx/${settlementTx}`);
  }
  console.log(`[5] payer identity: ERC-8004 agentId 894341 (Arc testnet registry 0x8004A818BFB912233c491871b3d84c89A494BD9e)`);
}

main().catch((err) => {
  console.error("payer agent failed:", err);
  process.exit(1);
});
