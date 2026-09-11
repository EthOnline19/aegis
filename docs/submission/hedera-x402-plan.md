# REPAYD — Hedera x402 Track Plan

**Target prize:** "AI & Agentic Payments on Hedera" — $6,000 (up to 3 × $2,000) at ETHOnline 2026.
**Scope:** a LIVE x402-gated service on Hedera testnet settled through the Blocky402 facilitator, plus an agent that completes at least one REAL paid request end-to-end. Public repo + README (setup/architecture/payment flow) + ≤5 min demo video.

This document is the research record and build plan. Sources read this session: `hedera-dev/x402-inference-pay-per-request-poc` (service + agent source files), `x402-foundation/x402` (protocol spec README + SDK layout), `blocky402.com/docs` (testnet + networks pages), `hashgraph/hedera-agent-kit-js`, `docs.hedera.com`.

---

## 1. What the prize requires (verbatim requirements)

| Requirement | How REPAYD hits it |
|---|---|
| Host a LIVE x402-gated service on Hedera testnet settled through the Blocky402 facilitator | `packages/hedera` — the REPAYD Coverage & Risk API, three pay-per-call endpoints behind an x402 `exact`/`hedera:testnet` paywall, verification + settlement delegated to `https://api.testnet.blocky402.com` |
| Build a platform/agent that consumes it and completes at least one REAL paid request end-to-end | `packages/hedera/scripts/paid-request.ts` — the REPAYD payer agent; discovers the service via `/v1/x402/services`, pays the 402 challenge through Blocky402, receives the payload |
| Public repo + README (setup / architecture / payment flow) | `packages/hedera/README.md` |
| Demo video ≤5 min showing the paid request executing | recorded after keys land (out of this doc's scope; script lives in the README's demo section) |

## 2. Protocol facts (from the sources)

**x402 flow (v2):**
1. Client requests resource → server returns **402** with `PAYMENT-REQUIRED` header carrying base64 JSON `PaymentRequirements[]` (`scheme`, `network`, `maxAmountExpected`/price, `asset`, `payTo`, `maxTimeoutSeconds`, `resource`, `extra`).
2. Client selects requirements, builds a `PaymentPayload` for that `(scheme, network)`, retries with `X-PAYMENT` header (v2 header name; PoC also tolerates `PAYMENT-SIGNATURE`).
3. Server POSTs `{x402Version, paymentPayload, paymentRequirements}` to facilitator `/verify`.
4. On `isValid`, server does the work, returns 200 with `PAYMENT-RESPONSE` header (settlement).
5. Server (or after response) POSTs to facilitator `/settle`; facilitator signs/submits on-chain and returns `{transaction, network, ...}`.

**Hedera specifics:**
- `network: "hedera:testnet"`; accounts are `0.0.x`; `asset: "0.0.0"` is native HBAR; HTS tokens use their `0.0.x` token id as `asset`.
- The payer signs a `TransferTransaction`; the **facilitator acts as fee-payer** (its account is advertised at `GET /supported` → `signers["hedera:*"][0]` / `kinds[].extra.feePayer`); pass that into `extra.feePayer` in the requirements. Client accounts therefore need only the payment balance, not gas.
- Blocky402 hosted **testnet** facilitator: `https://api.testnet.blocky402.com` — open access, no API key, advertises `hedera:testnet`. (The PoC routes testnet through x402.org; the bounty explicitly names Blocky402, and Blocky402's hosted testnet supports Hedera — we use Blocky402 for both testnet per the bounty.)
- Hedera **testnet USDC** is `0.0.429274` and requires an HTS token association on both payer and receiver before use. **Decision: price in native HBAR** (`asset: "0.0.0"`) — no association prerequisite, no faucet dependency beyond HBAR; keeps the end-to-end setup one faucet away. Amounts are tinybars (1 HBAR = 10⁸ tinybars).

**Reference PoC patterns we adopt (adapted, not copied):**
- Server: `paymentMiddleware` route table `{ "GET /path": { accepts: [...], description, mimeType } }` from `@x402/express` wired to an `x402ResourceServer(HTTPFacilitatorClient).register("hedera:*", new ExactHederaScheme())` from `@x402/core/server` + `@x402/hedera/exact/server`.
- Client: `wrapFetchWithPayment(fetch, x402Client.register("hedera:*", new ExactHederaScheme(createClientHederaSigner(accountId, key, {network}))))` from `@x402/fetch` + `@x402/hedera`.
- Settlement is facilitator-driven and async; the 200 can precede final settlement (server verifies first, settles after/around serving).

**Hedera account setup (docs.hedera.com / portal):** create ECDSA accounts at `portal.hedera.com` (testnet), fund via the portal/faucet. HCS topic creation + submits use `@hiero-ledger/sdk` `Client.forTestnet().setOperator(account, key)`.

## 3. Architecture

```
                         ┌────────────────────────────────────────────┐
                         │  REPAYD Arc testnet (existing, read-only)  │
                         │  ERC-8004 identity registry 0x8004A8…BD9e  │
                         │  validation registry        0x8004Cb…4272  │
                         └───────────────▲────────────────────────────┘
                                         │ eth_call (read-only): ownerOf(agentId),
                                         │ getValidationStatus(digest)
┌──────────────┐   1. GET (no payment)   │
│  REPAYD      │──────────────────────► │
│  payer agent │                        │
│ (paid-request│  2. 402 + requirements │
│  .ts)        │◄──────────────────────┤
│              │                        │        packages/hedera — service
│ signer:      │  3. X-PAYMENT retry    │        (Bun, Hono-style routing via
│ HEDERA_      │──────────────────────► │         @x402/express middleware)
│ OPERATOR_KEY │                        │              │
└──────┬───────┘                        │              │ 4. POST /verify
       │                                │              ▼
       │   TransferTransaction          │     https://api.testnet.blocky402.com
       │   (payer-signed,               │              │ 5. POST /settle (async)
       │    facilitator fee-payer)      │              │ co-signs + submits to
       └────────────────────────────────┴──────────────┘ Hedera testnet
                                         │
                        6. 200 + payload + PAYMENT-RESPONSE (tx id)
                                         │
                        7. (gated) HCS receipt memo: ConsensusSubmitMessage
                           to topic — "REPAYD x402 receipt: tx=<id> endpoint=…
                           agent=894341 digest=…"  → verifiable audit trail
```

**Service endpoints (pay-per-call, per-endpoint pricing — metering extra point):**

| Endpoint | Price (HBAR, tinybars) | Payload |
|---|---|---|
| `GET /v1/x402/quote?agent=<evm-addr>` | 0.001 HBAR (`100000` tbar) | Live risk quote via `@bulwark/engine` `quote()` on a deterministic `DrivingRecord` keyed to the agent address (Step-4 run facts for the demo agent) |
| `GET /v1/x402/verdicts/<digest>` | 0.002 HBAR (`200000` tbar) | The ERC-8004-mirrored verdict record — real digest `0x1af03bc6a70b6309bd5c9ec92c7d78c1024e0d69c9ea5ea60faf828c958ed3f0` (Step-4 run: score 25 COVERED, payout $135, feedback −2500@2dp) |
| `GET /v1/x402/resume/<ens>` | 0.0015 HBAR (`150000` tbar) | The résumé block (`@bulwark/record` `buildResume` + `renderResume`) |
| `GET /v1/x402/services` | free | JSON discovery directory of the above (directory extra point) |
| `GET /healthz` | free | liveness |

**Payer agent** (`scripts/paid-request.ts`): reads `/v1/x402/services` (discovery), picks the quote endpoint, wraps fetch with `@x402/fetch` + Hedera signer, completes one paid request, prints the settlement transaction id + HashScan link. Identifies as ERC-8004 `agentId 894341` via header/query; the service cross-validates against the canonical Arc identity registry (read-only `ownerOf`) when `ARC_RPC_URL` is set.

**Dry-run default:** every chain-touching path (payer signing, HCS submit) is gated behind env (`HEDERA_OPERATOR_KEY` + `HEDERA_NETWORK=testnet`, `HEDERA_SERVICE_KEY` for HCS). Without keys the script prints the exact flow it would execute (the 402 → requirements → transfer → verify → settle → 200 sequence with real numbers). The service itself only needs the Blocky402 facilitator URL to run (verification/settlement are facilitator calls, not local chain writes); HCS audit is separately gated.

## 4. Extra-points matrix (each is explicitly scored)

| Scored item | REPAYD claim | Implementation |
|---|---|---|
| Pay-per-call inference/data/compute metering | ✅ | Per-endpoint pricing table above (`ENDPOINT_PRICING` in `src/pricing-meter.ts`); every 402 challenge carries the endpoint's exact tinybar price; `/v1/x402/services` advertises prices up front; served requests are counted per endpoint (call counter in the service, exposed on `/healthz`) |
| On-chain agent identity via ERC-8004 or HCS-14 | ✅ | Payer identifies as ERC-8004 `agentId 894341` (registered on the canonical Arc testnet identity registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, owner `0x0549…33A6`). The service validates the claimed agentId via read-only `ownerOf`/`getAgentWallet` eth_calls when `ARC_RPC_URL` is set, and stamps the id into the HCS audit memo. Cross-chain story: identity lives on Arc (ERC-8004), payments settle on Hedera (x402), the audit memo links the two chains |
| Agent discovery via UCP or a directory | ✅ | `GET /v1/x402/services` returns a JSON directory: endpoint, description, mimeType, price, network, scheme, payTo — the discovery entry the payer agent consumes before paying |
| HTS tokens or custom fee schedules in settlement | ✅ (partial) | Settlement asset is native HBAR via the x402 `exact` scheme; the service's pricing table is expressed in tinybars and documented as a fee schedule per endpoint. HTS-token settlement (e.g. testnet USDC `0.0.429274`) is supported by the same `ExactHederaScheme` via the `asset` field — documented as a config flip (`HEDERA_ASSET=0.0.429274`), not default, because USDC requires the token-association prerequisite on both accounts |
| Verifiable payment audit trails on HCS | ✅ (gated) | After a successful settlement, the service submits a payment-receipt memo to an HCS topic (`ConsensusSubmitMessage`, `HEDERA_RECEIPT_TOPIC_ID`; auto-create topic on first run when `HEDERA_SERVICE_KEY` present). Memo JSON: `{kind:"x402-receipt", tx, network, endpoint, price, agentId, ts}`. Every memo is publicly verifiable on HashScan/DragonGlass. Dry-run default: logs the memo it would submit |
| Recurring/streamed payments via Scheduled Transactions | ✅ (documented + code) | The REPAYD premium is charged **per block the agent is active** (pricing engine) — the natural Hedera mapping is a `ScheduleCreate` with `ScheduleSign`-style recurring premium draws. `scripts/schedule-premium.ts` creates a real scheduled recurring HBAR transfer (gated); README §Scheduled documents the exact HAPI call chain and how per-block premium maps to scheduled cadence |
| Multi-agent negotiation via A2A or ACP | — (not claimed) | Out of scope this pass; noted for roadmap |

## 5. Credential list ([NEEDS])

| Credential | Used by | Notes |
|---|---|---|
| `HEDERA_OPERATOR_ID` + `HEDERA_OPERATOR_KEY` (ECDSA) | payer agent | The account that signs the x402 transfer. Needs testnet HBAR balance (the facilitator is fee-payer for gas, but the transfer amount itself is debited from this account). **[NEEDS: Hedera testnet operator account + HBAR faucet]** |
| `HEDERA_SERVICE_ID` + `HEDERA_SERVICE_KEY` (ECDSA) | service (payTo) + HCS audit | The `payTo` account that receives payments; its key signs HCS receipt memos. Needs a little HBAR for the HCS submits (payments themselves need no gas on the receiver). **[NEEDS: Hedera testnet service account + small HBAR]** |
| `HEDERA_NETWORK` | all | `testnet` — constant for this bounty |
| `ARC_RPC_URL` | identity validation | optional; defaults to the public `https://rpc.testnet.arc.io` (read-only calls, no key) |

Setup path for the user: `portal.hedera.com` → create 2 ECDSA testnet accounts → fund both via the portal faucet (`faucet.hedera.com`) → paste into `.env`. No Blocky402 key needed (hosted testnet is open access).

## 6. Package layout

```
packages/hedera/
├── package.json          (@repayd/hedera; bun; deps: @x402/express @x402/fetch
├──                        @x402/core @x402/hedera express @hiero-ledger/sdk
├──                        @bulwark/engine @bulwark/record viem)
├── tsconfig.json
├── README.md             setup / architecture / payment flow / extra-points
├── .env.example
├── src/
│   ├── server.ts         service entry (paymentMiddleware route table)
│   ├── pricing-meter.ts  per-endpoint price table + call counters
│   ├── payloads.ts       quote/verdict/résumé builders (real Step-4 data)
│   ├── identity.ts       ERC-8004 agentId validation vs Arc (read-only)
│   └── hcs.ts            payment-receipt HCS audit trail (gated)
├── scripts/
│   ├── paid-request.ts   payer agent — real paid request end-to-end (gated)
│   └── schedule-premium.ts  recurring premium via Scheduled Transactions (gated)
└── test/
    ├── challenge.test.ts     402 challenge/response shape, X-PAYMENT retry,
    │                          mocked facilitator verify/settle
    └── pricing-meter.test.ts per-endpoint pricing, metering counters,
                              directory payload
```

## 7. Verification plan

- `bun test` in `packages/hedera` — challenge/response with a mocked facilitator (both verify-invalid → re-402 and verify-valid → serve paths), pricing metering, directory shape.
- Dry-run of `paid-request.ts` prints the full flow.
- Live run (once keys land): service up → agent pays → 200 received → settlement tx id printed + HashScan link → HCS memo visible on the topic.
