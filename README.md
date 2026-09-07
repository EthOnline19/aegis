# BULWARK

**Deposit insurance for AI agents. The seatbelt, the airbag, the black box, and the fleet contract — one machine.**

> Everyone is giving AI agents wallets. Nobody is insuring them. Now there's a name for that.

A protected wallet that **holds** suspicious transactions for two minutes while a sealed, tamper-proof referee checks them, **blocks** clear violations outright, **proves who instructed what** (so owners can't fake attacks to collect insurance), and **pays back automatically — in the same block —** for whatever slips through. Coverage is priced by how the agent actually behaves: safe agents get cheaper every week. And the whole machine is sold as an API to the platforms that launch agents.

---

## The architecture

```
┌────────────────────────────────────────────────────────────┐
│                     THE OWNER (Amara)                       │
│           World ID login · phone for alerts                 │
└─────────────────────────────┬──────────────────────────────┘
                              │ installs SDK, sets policy
                              ▼
┌────────────────────────────────────────────────────────────┐
│  1. GUARDACCOUNT — the protected wallet (three lanes)      │
│     ROUTINE executes instantly · ELEVATED holds 2 min      │
│     · VIOLATION blocks before broadcast                    │
├────────────────────────────────────────────────────────────┤
│  2. POLICY — the rules of normal (on-chain, versioned)     │
│  3. HOLD WINDOW — T+2min containment, fail-safe lapse      │
│  4. WATCHER & VERDICT ENGINE — deterministic, TEE-signed   │
│     + THE ALIBI CHECK: was the instruction owner-signed?   │
│  5. MUTUAL POOL — USDC, junior/senior tranches             │
│  6. PRICING ENGINE — telematics for machines               │
│  7. RISK SUBGRAPH + ENSv2 RECORD — the public memory       │
│  8. COVERAGE API — the business                            │
└────────────────────────────────────────────────────────────┘
```

**The design law:** *the AI narrates, the code decides.* No LLM judgment in any decision path — every tier, verdict, and payout is deterministic arithmetic that anyone can re-run and compare digests. (Plan §39: re-execution, not authority.)

## Repository layout

| Package | What it is | Proof |
|---|---|---|
| `contracts/` | Solidity (Foundry): `PolicyRegistry`, `GuardAccount`, `VerdictContract`, `MutualPool`, `Blocklist` | **53 tests** (unit + 1000-run fuzz invariants) |
| `packages/engine` | The Watcher & Verdict Engine + Pricing Engine — deterministic TS, CRE-ready | **27 tests** |
| `packages/sdk` | The Agent SDK — instruction hash-chain (the alibi) | **9 tests** |
| `packages/api` | The Coverage API — embedded insurance for platforms | **12 tests** + live smoke |
| `packages/subgraph` | The Risk Subgraph — every policy, verdict, claim, blocklist entry | codegen + WASM build |
| `packages/dashboard` | Three surfaces: Owner, Capital, Record | content-verified + API-integrated |
| `packages/demo` | The two-gasp demo — live on anvil, the full plan §35 script | **exit 0, verified** |

## Quick start

```bash
# 1. Contracts — unit + fuzz invariant tests (53)
cd contracts && forge test

# 2. Engine + SDK + API (48 vitest tests)
cd ../ && bun install
(cd packages/engine && bunx vitest run)
(cd packages/sdk     && bunx vitest run)
(cd packages/api     && bunx vitest run)

# 3. The demo — the two-gasp choreography, live on anvil
anvil --port 8545 &                      # local chain
cd packages/demo && bun run src/demo.ts  # ~100s of theater, exit 0

# 4. The Coverage API + dashboards
cd ../api       && bun run start         # :8787
cd ../dashboard && bun run start         # :3000 → / · /capital · /record

# 5. The Risk Subgraph
cd ../subgraph && bunx graph codegen && bunx graph build
```

Requires: [Foundry](https://getfoundry.sh), [Bun](https://bun.sh) ≥1.2.

## The demo (what you'll see)

```
[0:20] ROUTINE   — 5 payroll txs execute instantly (the seatbelt you never feel)
[0:45] GASP ONE  — hidden web-page instruction → $150 to a 3-day-old wallet
                  at 4AM → hold window → TEE verdict: FREEZE
                  (NEW_RECIPIENT · RECIPIENT_BRAND_NEW · UNUSUAL_HOUR — all
                  VERIFIED/COMPUTED, nothing INFERRED)
                  → Amara freezes → $0 moved → THE ATTACK NEVER SETTLED
                  → the $900 admin override hits the on-chain WALL
[1:30] GASP TWO  — look-alike address (edit distance 1) slips the routine lane
                  → $150 leaves → anomaly flags it → alibi check:
                  INSTRUCTION ORIGIN: EXTERNAL → COVERED
                  → $135 lands in Amara's wallet, SAME BLOCK as the verdict
[2:20] FRAUD KILL— Nuno's own instruction, signed by his session key,
                  visible in the hash-chain → CLAIM DENIED: OWNER-ORIGIN
[2:40] THE RECORD— resolve atlas.bulwark.eth → the full public résumé
```

## The critical invariants (fuzz-tested)

- **I1 — fund conservation:** funds leave a GuardAccount only via executed routine, released hold, or owner withdrawal. Fuzzed across arbitrary proposals.
- **I2 — custody never locked:** hold-state funds are always recoverable by the owner; fail-safe lapse (extend 60 min → auto-freeze) never strands money.
- **I3 — solvency:** payouts never exceed junior + senior capital; the waterfall absorbs junior-first, senior-overflow; insolvent claims revert.
- **I4 — no double claims:** one payout per breached tx hash (nullifier).
- **Payout ≤ cap; payout + deductible ≤ loss** — enforced on-chain and mirrored in the TS engine.
- **Signature discipline:** every verdict is ECDSA-verified against the watcher key (EIP-191, malleability-guarded, freshness-windowed, policy-hash-pinned).

## The fraud moat (the Cryptographic Alibi)

The deepest hole in agent insurance is the owner attacking themselves: drain the wallet, claim "hijack," collect. BULWARK proves which side the instruction came from:

- Every instruction the agent receives is hashed into a rolling chain: `keccak(prev ‖ origin ‖ ownerSigned ‖ ts ‖ keccak(instruction))`.
- Owner-console instructions are signed with the owner's session key; everything else is marked external.
- At claim time the alibi check runs: **owner-signed → DENIED** (the act of ordering the attack is the act of confessing); **external → COVERED EVENT.**
- Tampering breaks the chain visibly — `computeEntryDigest` is exported so anyone can re-run the check on public data.

## Pricing (telematics for machines)

```
premium = base_rate (2%/mo) × coverage_cap × product(multipliers)
  streak_discount  −60% at 180 clean days      anomaly_load  +0–40%
  attempt_load     +15% for 30d after a breach  claim_load    ×3 (×5 for 2+)
  kya_discount     −20% World-ID verified       sdk_discount −10%
  watch_only_load  ×2 (no containment)          — charged per active block
```

Deterministic, public, every number labeled COMPUTED or VERIFIED.

## Scope honesty (deliberately v2)

- **Cat-bond reinsurance** — the hook + attachment are wired (`MutualPool.setReinsurance`); the live NextBlock-style layer is roadmap (cited, not built).
- **Freeze partners / forensics fan-out** — the verdict engine emits the package; exchange integrations are post-hackathon.
- **Pricing v2** — v1 is the deterministic formula above; "trains on the subgraph" is the roadmap slide.
- **EN Sv2 / World ID / Arc** — the contracts are chain-agnostic and test on anvil; Arc-testnet + EN Sv2 + World ID wiring is the deploy step.
- **TEE** — the verdict core is deterministic TS ready for Chainlink CRE; the demo signs with a watcher key standing in for the TEE.

## Verification ledger

| Claim | Evidence |
|---|---|
| Contracts compile + 53 tests pass | `forge test` — all suites `ok` |
| Fuzz invariants hold | 6 property tests × 1000 runs |
| Engine determinism | 27 tests incl. same-inputs-same-verdict |
| Alibi fraud resistance | owner-signed → DENIED, both in Solidity and TS tests |
| Same-block payout | demo: `$135 landed — SAME BLOCK as the verdict`; `Payout` event at block 262 |
| Pool waterfall | junior $20,000 → $19,865; senior untouched |
| Attack never settles | demo: `0xFresh received $0`; wall blocked $900 pre-broadcast |
| Coverage API business | 12 tests + live POST /v1/coverage round-trip |
| Subgraph compiles | `graph build` → `build/subgraph.yaml` + WASM |
| Dashboards render | all three pages content-verified; platform proxy integration live |

---

*BULWARK — hold what's suspicious, prove who instructed what, pay what slips through — in the same block — and sell the whole machine to every platform launching agents.*
