# REPAYD

**Deposit insurance for AI agents. The seatbelt, the airbag, the black box, and the fleet contract — one machine.**

> Everyone is giving AI agents wallets. Nobody is insuring them. Now there's a name for that.

*(Renamed from BULWARK this session — the on-chain run artifacts below still carry the historical `bulwark-verdict` tags.)*

A protected wallet that **holds** suspicious transactions for two minutes while a sealed, tamper-proof referee checks them, **blocks** clear violations outright, **proves who instructed what** (so owners can't fake attacks to collect insurance), and **pays back automatically — in the same block —** for whatever slips through. Coverage is priced by how the agent actually behaves: safe agents get cheaper every week. And the whole machine is sold as an API to the platforms that launch agents.

**This is not a mockup.** The protocol ran live on **Arc testnet** on 2026-09-11: 14 transactions, every hash independently re-fetched and verified, agent identity **894341** registered on the canonical ERC-8004 registries, a $135 covered-claim payout settled **in the same block as the verdict** (tx [`0xed020f97…a299f6`](https://testnet.arcscan.app/tx/0xed020f97235164333e416ae494c6b24462a6884e1aa2ba1a1898b85d07a299f6)). Full verification report: [`local/step4-final-report.md`](local/step4-final-report.md).

---

## ETHOnline 2026 — three-track submission

| Track | Bounty | Claim | Compliance matrix |
|---|---|---|---|
| **Arc** — Best Agentic Economy Application with Circle Agent Stack | $3,500 (+$2,500 mainnet rider) | An agent that **autonomously spends USDC** (4 payroll txs from its own key), survives two live attacks (hold + pre-broadcast block), and **settles a covered claim same-block** — with ERC-8004 on-chain identity, deterministic decision logic tied to real signals, and Circle Agent Stack wiring | [`docs/submission/compliance-matrix.md`](docs/submission/compliance-matrix.md#track-1--arc-best-agentic-economy-application-with-circle-agent-stack-3500-2500-of-the-pool-requires-arc-mainnet-deploy-by-sept-30-2026) |
| **The Graph** — Best AI Tooling or AI Use Case (From Scratch) + Best Use of Composable or Standardized Graph Products | $5,000 + $5,000 | The **REPAYD Risk Subgraph**: 36 events, 9 entities, live provider data (Studio deploy), consumed by the AI **pricing engine** (streaks → premium decisions) and **risk-posture consumer** — plus composition with the **ERC-8004/Agent0 standardized schema** on `agentId` | [`docs/submission/compliance-matrix.md`](docs/submission/compliance-matrix.md#track-2a--the-graph-best-ai-tooling-or-ai-use-case-from-scratch-5000) |
| **Hedera** — AI & Agentic Payments on Hedera | $6,000 (up to 3 × $2,000) | A **live x402-gated Risk Posture service on Hedera testnet** settled through Blocky402, consumed by the same guard agent in a **real paid request end-to-end** — with ERC-8004 cross-chain identity, HCS audit receipts, and scheduled-transaction settlement | [`docs/submission/compliance-matrix.md`](docs/submission/compliance-matrix.md#track-3--hedera-ai--agentic-payments-on-hedera-6000-up-to-3--2000) |

Video scripts (recordable now for Arc; post-credential for Graph/Hedera): [`docs/submission/video-scripts.md`](docs/submission/video-scripts.md).

## Quick start

```bash
# 1. Contracts — unit + fuzz invariant tests (53)
cd contracts && forge test

# 2. Engine + SDK + API + pricing + record (vitest suites)
cd ../ && bun install
(cd packages/engine   && bunx vitest run)   # 27 tests — determinism, verdicts
(cd packages/sdk      && bunx vitest run)   # 9 tests  — the alibi hash-chain
(cd packages/api      && bunx vitest run)   # 12 tests — coverage bridge
(cd packages/pricing  && bunx vitest run)   # §12 formula invariants
(cd packages/record   && bunx vitest run)   # résumé + ENSv2 mapping

# 3. The two-gasp demo — the full choreography (anvil locally, Arc testnet live)
anvil --port 8545 &                      # or: point .env at Arc testnet keys
cd packages/demo && bun run src/demo.ts  # exit 0

# 4. Coverage API + dashboards
cd ../api       && bun run start         # :8787
cd ../dashboard && bun run start         # :3000 → / · /capital · /record

# 5. Risk Subgraph — codegen + WASM build (deploy recipe in packages/subgraph/README.md)
cd ../subgraph && bunx graph codegen && bunx graph build
```

Requires: [Foundry](https://getfoundry.sh), [Bun](https://bun.sh) ≥1.2.

## Architecture

Architecture diagram + narrative: [`docs/submission/architecture.md`](docs/submission/architecture.md) (the short version):

```
┌────────────────────────────────────────────────────────────┐
│                     THE OWNER (Amara)                       │
├────────────────────────────────────────────────────────────┤
│  1. GUARDACCOUNT — the protected wallet (three lanes)      │
│     ROUTINE executes instantly · ELEVATED holds 2 min      │
│     · VIOLATION blocks before broadcast                    │
│  2. POLICY — the rules of normal (on-chain, versioned)     │
│  3. HOLD WINDOW — T+2min containment, fail-safe lapse      │
│  4. WATCHER & VERDICT ENGINE — deterministic, TEE-signed   │
│     + THE ALIBI CHECK: was the instruction owner-signed?   │
│  5. MUTUAL POOL — USDC, junior/senior tranches             │
│  6. PRICING ENGINE — telematics for machines               │
│  7. RISK SUBGRAPH (The Graph) + ENSv2 RECORD               │
│  8. COVERAGE API — the business                            │
│  +  ERC-8004 — cross-chain agent identity & reputation     │
│  +  x402/HCS — agents paying agents on Hedera              │
└────────────────────────────────────────────────────────────┘
```

**The design law:** *the AI narrates, the code decides.* No LLM judgment in any decision path — every tier, verdict, and payout is deterministic arithmetic that anyone can re-run and compare digests.

## Repository layout

| Package | What it is | Proof |
|---|---|---|
| `contracts/` | Solidity (Foundry): `PolicyRegistry`, `GuardAccount`, `VerdictContract`, `MutualPool`, `Blocklist` + ERC-8004 integration | **53 tests** (unit + 1000-run fuzz invariants) |
| `packages/engine` | Watcher & Verdict Engine + deterministic TS core | **27 tests** incl. same-inputs-same-verdict |
| `packages/sdk` | Agent SDK — instruction hash-chain (the alibi) | **9 tests** |
| `packages/api` | Coverage API + ERC-8004 orchestrator (mirrors verdicts to the canonical registries) | **12 tests** + live Arc run (Step-4) |
| `packages/pricing` | The §12 pricing formula — streak/attempt/claim/anomaly multipliers with provenance labels | invariant + integration tests |
| `packages/record` | §13 résumé builder + ENSv2 writer/resolver (gated scripts) | tested; registration needs Sepolia funds |
| `packages/subgraph` | The Risk Subgraph — 36 events, 9 entities, Arc testnet manifest | codegen + WASM build verified |
| `packages/dashboard` | Owner / Capital / Record surfaces | content-verified + API-integrated |
| `packages/demo` | The two-gasp demo — anvil locally, **Arc testnet live** | **exit 0; 14 txs independently verified** |

## What we proved on-chain (Step-4, Arc testnet, 2026-09-11)

- 14 transactions, all re-fetched status 0x1, correct senders and contracts — [full table with Arcscan links](local/step4-final-report.md).
- ERC-8004 agent **894341**: identity owner `0x0549…33A6`, wallet binding verified; validation score **25 (COVERED)**, responseHash `0x1af03bc6…d3f0` matching the on-chain `VerdictAccepted.digest`; reputation feedback **−2500 @ 2dp**, tags `bulwark-verdict`/`covered`.
- Autonomous agent spending: 4 USDC payroll txs ($800 total) from the agent's own key.
- Attack #1 ($150 → 3-day-old wallet): **held, frozen, never settled** — FRESH_WALLET balance 0.
- Attack #2 ($900 admin override): **blocked pre-broadcast** — no tx exists, ATTACKER balance 0.
- Look-alike slip: held by the elevated lane, covered verdict → **$135 payout same-block** as the verdict.
- Daily-spend accounting honest on-chain: day 20707, $800 spent, count 4 — held amounts excluded.

## What needs credentials (honest status)

Full list with owners and unblocks: [`docs/submission/credential-checklist.md`](docs/submission/credential-checklist.md).

1. **The Graph Studio deploy key** — deploys the Risk Subgraph to `arc-testnet`; unblocks the live-provider-data gates of **both** $5,000 Graph tracks. Everything else for those tracks (schema, mappings, consumers) is built and tested.
2. **Hedera testnet operator keys** — deploy the x402-gated service via Blocky402 and execute the first real paid request; unblocks the $6,000 track's core requirement and video.
3. **Circle API key** — direct Agent Stack / Paymaster / Nanopayments API calls; the Arc track's core (autonomous USDC spending, decision logic, same-block settlement) is already proven on-chain without it.
4. **Arc mainnet decision** — the $2,500 rider needs a mainnet deploy by **Sept 30, 2026**; contracts and deploy script are chain-agnostic and ready. **NEEDS DECISION.**
5. **Sepolia ETH + MockUSDC** — ENSv2 name registration for the agent-discovery extra credit.

## The fraud moat (the Cryptographic Alibi)

The deepest hole in agent insurance is the owner attacking themselves: drain the wallet, claim "hijack," collect. REPAYD proves which side the instruction came from:

- Every instruction the agent receives is hashed into a rolling chain: `keccak(prev ‖ origin ‖ ownerSigned ‖ ts ‖ keccak(instruction))`.
- Owner-console instructions are signed with the owner's session key; everything else is marked external.
- At claim time the alibi check runs: **owner-signed → DENIED** (the act of ordering the attack is the act of confessing); **external → COVERED EVENT.**
- Tampering breaks the chain visibly — `computeEntryDigest` is exported so anyone can re-run the check on public data.

## The critical invariants (fuzz-tested)

- **I1 — fund conservation:** funds leave a GuardAccount only via executed routine, released hold, or owner withdrawal.
- **I2 — custody never locked:** hold-state funds are always recoverable by the owner; fail-safe lapse never strands money.
- **I3 — solvency:** payouts never exceed junior + senior capital; insolvent claims revert.
- **I4 — no double claims:** one payout per breached tx hash (nullifier).
- **Payout ≤ cap; payout + deductible ≤ loss** — enforced on-chain and mirrored in the TS engine.
- **Signature discipline:** every verdict is ECDSA-verified against the watcher key (EIP-191, malleability-guarded, freshness-windowed, policy-hash-pinned).

## Scope honesty (deliberately v2)

- **Cat-bond reinsurance** — hook + attachment wired (`MutualPool.setReinsurance`); the live layer is roadmap.
- **Freeze partners / forensics fan-out** — the verdict engine emits the package; exchange integrations are post-hackathon.
- **Pricing v2** — v1 is the deterministic formula; "trains on the subgraph" is the roadmap slide.
- **TEE** — verdict core is deterministic TS ready for Chainlink CRE; the demo signs with a watcher key standing in for the TEE.

---

*REPAYD — hold what's suspicious, prove who instructed what, pay what slips through — in the same block — and sell the whole machine to every platform launching agents.*
