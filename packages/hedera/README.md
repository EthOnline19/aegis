# REPAYD — x402 Coverage & Risk API on Hedera (LIVE)

Pay-per-call agent insurance data on **Hedera testnet**, gated by **x402 v2** and settled
through the **Blocky402** hosted facilitator (`https://api.testnet.blocky402.com`).
The REPAYD payer agent completes real paid requests end-to-end:
`402 → payer-signed TransferTransaction → facilitator /verify → 200 + payload → /settle on-chain`.
Everything below was executed live — receipts in [§Demo — LIVE evidence](#demo--live-evidence).

```
REPAYD payer agent ──GET──► Coverage & Risk API (@x402/express) ──/verify,/settle──► Blocky402 ──► Hedera testnet
   signs X-PAYMENT            3 metered endpoints,                    open access        facilitator is
   (HEDERA_OPERATOR_KEY)      per-endpoint tinybar prices                               fee-payer (no gas
                                                                                        needed by payer)
        └── HCS receipt memo per paid call ──► topic 0.0.10493275 (public audit trail)
```

## Setup

```bash
# from the repo root (bun ≥ 1.2)
bun install
cp .env.example .env    # fill in the two Hedera testnet accounts

# 1. service — payTo + facilitator; HCS audit goes live when HEDERA_SERVICE_KEY is set
export HEDERA_SERVICE_ID=0.0.10484593 HEDERA_SERVICE_KEY=0x… \
       X402_FACILITATOR_URL=https://api.testnet.blocky402.com \
       HEDERA_NETWORK=testnet REPAYD_X402_PORT=4601 \
       HEDERA_RECEIPT_TOPIC_ID=0.0.10493275      # optional: reuse an existing audit topic
bun run packages/hedera/src/server.ts

# 2. payer agent — one REAL paid request (needs HEDERA_OPERATOR_ID/KEY, funded with testnet HBAR)
export HEDERA_OPERATOR_ID=0.0.10484477 HEDERA_OPERATOR_KEY=0x… REPAYD_SERVICE_URL=http://localhost:4601
bun run packages/hedera/scripts/paid-request.ts

# 3. recurring premium via Scheduled Transactions (live with keys, dry-run plan without)
bun run packages/hedera/scripts/schedule-premium.ts

# tests / typecheck
cd packages/hedera && bun test        # 19/19
bunx tsc --noEmit -p tsconfig.json
```

Accounts: create two ECDSA testnet accounts at `portal.hedera.com`, fund via the faucet. The
**payer** needs only the balance it transfers (the facilitator `0.0.7162784` pays all gas); the
**service** account needs a little HBAR to sign HCS receipt submits. No Blocky402 key — hosted
testnet is open access.

| Env | Meaning | Default |
|---|---|---|
| `HEDERA_SERVICE_ID` | x402 `payTo` (receives payments) | required |
| `X402_FACILITATOR_URL` | facilitator | `https://api.testnet.blocky402.com` |
| `HEDERA_NETWORK=testnet` | + `HEDERA_SERVICE_KEY` ⇒ live HCS audit | dry-run |
| `HEDERA_RECEIPT_TOPIC_ID` | audit topic (auto-created when unset + live) | auto |
| `ARC_RPC_URL` | read-only ERC-8004 `ownerOf` validation | pinned facts |
| `REPAYD_X402_PORT` | service port | `4021` |

## Architecture

`src/server.ts` wires `paymentMiddleware` (`@x402/express`) to an
`x402ResourceServer(HTTPFacilitatorClient)` registered with `ExactHederaScheme`
(`@x402/hedera`) for `hedera:*`. Route table = the fee schedule:

| Endpoint | Price (tinybars, asset `0.0.0`) | Paid content |
|---|---|---|
| `GET /v1/x402/quote?agent=0x…&agentId=…` | `100000` (0.001 ℏ) | live risk quote — `@repayd/engine` multiplier + monthly premium from the agent's driving record (Step-4 facts) |
| `GET /v1/x402/verdicts/<digest>` | `200000` | ERC-8004-mirrored verdict record (digest `0x1af0…d3f0`: score 25 COVERED, $135 payout) |
| `GET /v1/x402/resume/<ens>` | `150000` | agent résumé block (`@repayd/record`, ENSv2 shape) |
| `GET /v1/x402/services` | free | JSON discovery directory: endpoints, prices, network, scheme, payTo, facilitator |
| `GET /healthz` | free | liveness + per-endpoint served-call/billed meter snapshot |

Modules: `pricing-meter.ts` (fee schedule + call counters), `payloads.ts` (deterministic
paid content from the real Step-4 run), `identity.ts` (ERC-8004 `agentId 894341` validation via
read-only `ownerOf`/`getAgentWallet` against the Arc testnet registry `0x8004A8…BD9e` when
`ARC_RPC_URL` is set; pinned facts otherwise — never a paywall gate), `hcs.ts` (payment-receipt
memos to an HCS topic, dry-run unless `HEDERA_SERVICE_KEY` + `HEDERA_NETWORK=testnet`).

## Payment flow

1. `GET /v1/x402/quote…` (no payment) → **402** + base64 `PAYMENT-REQUIRED`:
   `scheme=exact, network=hedera:testnet, amount=100000, asset=0.0.0, payTo=0.0.10484593,
   extra.feePayer=0.0.7162784` (facilitator pays all node fees).
2. The client (`@x402/fetch` `wrapFetchWithPayment` + `createClientHederaSigner`) builds a
   `TransferTransaction` (payer −100000 → payTo +100000 tinybars, fee-payer = facilitator) and
   signs it with `HEDERA_OPERATOR_KEY`; retries with the payment header.
3. Server POSTs `{paymentPayload, paymentRequirements}` to Blocky402 `/verify` → `isValid`.
4. Handler runs: identity check, pricing-engine quote, meter count, HCS audit memo; **200** +
   payload + base64 `PAYMENT-RESPONSE` settlement receipt.
5. `/settle`: the facilitator co-signs and submits the frozen transfer to testnet — the money
   moves on-chain, independently verifiable (see receipts below).

Spend controls: native HBAR (`0.0.0`) is not an x402 "default asset", so the payer opts it in
explicitly (`setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0" }] })`)
— the minimal client config; caps stay enforced. HTS settlement (e.g. testnet USDC `0.0.429274`)
is the same scheme via the `asset` field, behind the token-association prerequisite.

## Extra points claimed

- **Pay-per-call metering** — per-endpoint prices in every 402; served calls + billed tinybars
  counted per endpoint, exposed on `/healthz` (live snapshot below).
- **On-chain agent identity (ERC-8004)** — payer claims `agentId 894341` (Arc testnet registry);
  the service verifies `ownerOf` read-only and stamps the id into the HCS memo. Identity lives on
  Arc, money settles on Hedera, the memo links the two chains.
- **Agent discovery** — free `/v1/x402/services` directory the payer consumes before paying.
- **Verifiable audit trail on HCS** — one receipt memo per paid call on topic `0.0.10493275`
  (live — two memos below).
- **Recurring/streamed payments** — `schedule-premium.ts` created + executed a real
  `ScheduleCreate` premium draw: schedule `0.0.10493353` (HashScan below); cadence anchor is one
  ScheduleCreate per block-epoch, matching the per-block pricing engine.

## Demo — LIVE evidence

Run date 2026-09-12, Hedera **testnet**, facilitator `api.testnet.blocky402.com`.
Service on `:4601`; payer `0.0.10484477`; payTo `0.0.10484593`.

### (a) Decoded 402 challenge (`PAYMENT-REQUIRED` header, base64 JSON)

```
$ curl -s http://localhost:4601/v1/x402/quote?agent=0x05499b0be3B9E9Db3Cc5124b2F682513D94133A6&agentId=894341
HTTP/1.1 402 Payment Required
```
```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4601/v1/x402/quote?agent=0x0549…33A6&agentId=894341",
    "description": "REPAYD live risk quote — deterministic premium multiplier + monthly premium from the driving record",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "exact",
    "network": "hedera:testnet",
    "amount": "100000",
    "asset": "0.0.0",
    "payTo": "0.0.10484593",
    "maxTimeoutSeconds": 60,
    "extra": { "feePayer": "0.0.7162784" }
  }]
}
```

### (b) Served 200 payload (paid with 0.001 ℏ — real quote, Arc-verified identity)

```
$ bun run packages/hedera/scripts/paid-request.ts        # live path
[1] discovery: 3 metered endpoints, network=hedera:testnet, payTo=0.0.10484593
[2] paying 0.001 HBAR (100000 tinybars) for GET /v1/x402/quote?agent=0x0549…33A6&agentId=894341
[3] 200 OK — paid payload received:
{
  "kind": "repayd.quote",
  "agent": "0x05499b0be3b9e9db3cc5124b2f682513d94133a6",
  "agentId": "894341",
  "coverageCap": "2500000000",
  "multiplier": 2.1958560000000005,
  "monthlyPremium": "109792800",
  "premiumLabel": "4.39%/mo-equiv",
  "reasons": [
    { "tag": "STREAK_DISCOUNT", "provenance": 1, "detail": "1 clean days → −0.3%" },
    { "tag": "ANOMALY_LOAD",    "provenance": 1, "detail": "behavioral variance → +2.0%" },
    { "tag": "CLAIM_LOAD",      "provenance": 1, "detail": "paid claim within 6 months → ×3" },
    { "tag": "KYA_DISCOUNT",    "provenance": 0, "detail": "backing human is World-ID verified → −20%" },
    { "tag": "SDK_DISCOUNT",    "provenance": 0, "detail": "alibi SDK installed → −10%" }
  ],
  "computedAt": 1789190205,
  "identity": {
    "status": "verified",
    "agentId": "894341",
    "owner": "0x05499b0be3B9E9Db3Cc5124b2F682513D94133A6",
    "wallet": "0x9675b4D20d2ACFE55D00a02D55B9cdb57AEbD482"
  },
  "pricePaid": "0.001 HBAR"
}
[4] settlement: success=true tx=0.0.7162784@1789190197.536086930 payer=0.0.10484477
    https://hashscan.io/testnet/transaction/0.0.7162784-1789190197.536086930
```

`identity.status: verified` is a live `ownerOf(894341)` read against the Arc registry —
the owner matches the queried agent address.

### (c) Settlement transactions — HashScan + mirror-node receipts

Two REAL paid requests settled (the first run before the header-decode fix, then the clean run):

| tx | HashScan | result |
|---|---|---|
| `0.0.7162784@1789189943.758655274` | https://hashscan.io/testnet/transaction/0.0.7162784-1789189943-758655274 | SUCCESS |
| `0.0.7162784@1789190197.536086930` | https://hashscan.io/testnet/transaction/0.0.7162784-1789190197-536086930 | SUCCESS |

Mirror-node receipt for the second (`…-1789190197-536086930`):

```json
{ "name": "CRYPTOTRANSFER", "result": "SUCCESS", "charged_tx_fee": 268377,
  "transfers": [
    { "account": "0.0.802",        "amount":  268377 },
    { "account": "0.0.7162784",    "amount": -268377 },   ← facilitator pays ALL node fees
    { "account": "0.0.10484477",   "amount": -100000 },   ← payer −0.001 ℏ
    { "account": "0.0.10484593",   "amount":  100000 } ] }← payTo +0.001 ℏ
```

### (d) Balance deltas (mirror node, tinybars)

Paid request #2 in isolation:

| account | before | after | Δ |
|---|---|---|---|
| payer `0.0.10484477` | 99,986,381,085 | 99,986,281,085 | **−100,000** = price, exact |
| payTo `0.0.10484593` | 99,986,451,679 | 99,986,222,273 | +100,000 payment −329,406 HCS submit fee |

(The payTo net also carries the audit-topic's per-call submit fees — the per-tx transfer table in
(c) is the clean +100000 proof.) Both accounts started at 1,000.0 ℏ funded.

### HCS audit memos (topic `0.0.10493275` — https://hashscan.io/testnet/topic/0.0.10493275)

One memo per paid call, submitted live with the service key; sequence 2 links the settled run:

```
seq 1  ts 1789189954.205361104  {"kind":"repayd.x402-receipt","tx":"pending-settlement:GET:/v1/x402/quote:1789189953361",
        "network":"hedera:testnet","endpoint":"quote","price":"100000","agentId":"894341","identityVerified":true,"ts":1789189953}
seq 2  ts 1789190206.448246847  {"kind":"repayd.x402-receipt","tx":"pending-settlement:GET:/v1/x402/quote:1789190205723",
        "network":"hedera:testnet","endpoint":"quote","price":"100000","agentId":"894341","identityVerified":true,"ts":1789190205}
```

Cross-link: memo `ts 1789190205` ↔ settlement tx validStart `1789190197` ↔
`PAYMENT-RESPONSE` `{"success":true,"payer":"0.0.10484477","transaction":"0.0.7162784@1789190197.536086930","network":"hedera:testnet"}`.

### Metering snapshot (`GET /healthz`, live)

```json
{"status":"ok","hcsAudit":"live",
 "meter":{"servedCalls":{"quote":1,"verdicts":0,"resume":0},
          "billedTinybars":{"quote":"100000","verdicts":"0","resume":"0"},
          "totalBilledTinybars":"100000"}}
```

### Scheduled recurring premium (live)

`schedule-premium.ts` with keys set created **and the network executed** the schedule
(`wait_for_expiry: false`, single-signer):

```
schedule created: 0.0.10493353        https://hashscan.io/testnet/schedule/0.0.10493353
  memo: "REPAYD premium: agentId 894341, per-block draw, 0.001 HBAR"
  executed_timestamp: 1789190167.858871887   signature type: ECDSA_SECP256K1
```

Dry-run plan (no keys) printed by the same script:

```
[DRY-RUN] HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set — no schedule created.
  Would submit to Hedera testnet (HAPI chain):
    ScheduleCreateTransaction
      .setScheduleMemo("REPAYD premium: agentId 894341, per-block draw, 0.001 HBAR")
      .setScheduledTransaction(
        TransferTransaction
          .addHbarTransfer(<operator 0.0.x>, -0.001 HBAR)
          .addHbarTransfer(<payTo 0.0.10484593>, +0.001 HBAR))
    .execute(Client.forTestnet().setOperator(<operator>, <ECDSA key>))
```

## Known constraints

- `PAYMENT-RESPONSE` carries the settlement **synchronously** here (Blocky402 settles before the
  200 flushes); if it were async the header would carry the pending receipt and HashScan stays
  authoritative via the payer's account history.
- HCS memos are written at handler time, so `tx` references the paid request
  (`pending-settlement:METHOD:PATH:ms`) rather than the settlement id — the cross-link table above
  joins memo ↔ settlement by timestamp + endpoint + price. Moving the memo after settle (needs the
  middleware to expose the settlement id to the handler) is the obvious next step.
- Testnet-only: mainnet would point `X402_FACILITATOR_URL` at Blocky402 mainnet and
  `createClientHederaSigner(…, { network })` accordingly.
