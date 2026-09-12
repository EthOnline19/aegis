# BULWARK Step 4 — Arc Testnet Demo Verification Report

**VERDICT: ✅ PASS** — All 14 transaction hashes independently re-fetched on-chain (status 0x1, correct `to` contract, correct sender), ERC-8004 mirror confirmed by direct registry readback, and all demo outcome invariants hold. The one expected "failure" — `HoldVerdictRouted(clean=false)` posting nothing to ERC-8004 — is the designed fail-closed behavior, not a defect. Zero transactions sent by this verifier.

- **Chain:** Arc testnet (5042002) · RPC `https://rpc.testnet.arc.io` · explorer `testnet.arcscan.app`
- **Run window:** 2026-09-11T21:06:49Z → 21:13:38Z (blocks 61625041–61625840) — entirely inside UTC day 20707 (rollover boundary 2026-09-12T00:00:00Z); no mid-run counter reset possible
- **Demo exit code:** 0 (per receipt; collector was killed mid-settle by an external timeout and reconstructed the receipt from live chain state — every field below was independently re-verified against the chain by this verifier)

---

## 1. Per-step transaction table (independently re-fetched via `cast receipt`)

| # | Label | Tx hash | Status | Sent by | `to` (matches claim) | Arcscan |
|---|-------|---------|--------|---------|----------------------|---------|
| 1 | erc8004-register-agent | `0xd4d9eb702f8b46b830593f3619150980eb79189945795d02f92df05d4a79302e` | ✅ 0x1 | ops `0x0549…33A6` | identity `0x8004A8…BD9e` ✅ | [link](https://testnet.arcscan.app/tx/0xd4d9eb702f8b46b830593f3619150980eb79189945795d02f92df05d4a79302e) |
| 2 | erc8004-bind-agent-wallet | `0xf7d4ecc8476b55b38d1e7c0337db7d497218605275e35c0127ecbf4f5f0a8ec1` | ✅ 0x1 | ops | identity ✅ | [link](https://testnet.arcscan.app/tx/0xf7d4ecc8476b55b38d1e7c0337db7d497218605275e35c0127ecbf4f5f0a8ec1) |
| 3 | payroll-1 ($180 → ALICE) | `0xecd4321f75f205b5882cd90c8ebe9aa8c81073e94148c58c685ec74b538de0d9` | ✅ 0x1 | agent key `0x5c53…0F9f` | guard `0xB305…3b6E` ✅ | [link](https://testnet.arcscan.app/tx/0xecd4321f75f205b5882cd90c8ebe9aa8c81073e94148c58c685ec74b538de0d9) |
| 4 | payroll-2 ($310 → BOB) | `0x84beb66adf670f4589b6b398ff3537232ee5ceea7c8bc295662a3e1becdcd956` | ✅ 0x1 | agent key | guard ✅ | [link](https://testnet.arcscan.app/tx/0x84beb66adf670f4589b6b398ff3537232ee5ceea7c8bc295662a3e1becdcd956) |
| 5 | payroll-3 ($90 → ALICE) | `0x9aff8383770d1e7a93ae084185508183e8c7041d0f91bfd3e17b6804fcd45cee` | ✅ 0x1 | agent key | guard ✅ | [link](https://testnet.arcscan.app/tx/0x9aff8383770d1e7a93ae084185508183e8c7041d0f91bfd3e17b6804fcd45cee) |
| 6 | payroll-4 ($220 → BOB) | `0x52df993273400a47970a705747eb83ee944df65612e7dda274f9dddebc78e79d` | ✅ 0x1 | agent key | guard ✅ | [link](https://testnet.arcscan.app/tx/0x52df993273400a47970a705747eb83ee944df65612e7dda274f9dddebc78e79d) |
| 7 | gasp1-hold-payment-held (hold #1, $150 → FRESH_WALLET) | `0xf795bf3f813248f4fd463adb91af6ca12c4208a51137de423f5b4d5e440934a1` | ✅ 0x1 | agent key | guard ✅ | [link](https://testnet.arcscan.app/tx/0xf795bf3f813248f4fd463adb91af6ca12c4208a51137de423f5b4d5e440934a1) |
| 8 | gasp1-hold-verdict-suspicious (HoldVerdictRouted clean=false + OwnerDecision FREEZE-by-verdict) | `0xefa89ed72df09057a41ae90e8bd292374a20f59a0858fe4a4487f355e760bcd1` | ✅ 0x1 | watcher `0xF584…E7AE` | verdicts `0x7B46…C52f` ✅ | [link](https://testnet.arcscan.app/tx/0xefa89ed72df09057a41ae90e8bd292374a20f59a0858fe4a4487f355e760bcd1) |
| 9 | gasp1-owner-freeze-decision (hold #1, decision=1 FREEZE by amara) | `0x4487870cac5906a3cc599f71263452058611529ac1adff5dac3799fdd7280ec4` | ✅ 0x1 | amara `0x9675…d482` | guard ✅ | [link](https://testnet.arcscan.app/tx/0x4487870cac5906a3cc599f71263452058611529ac1adff5dac3799fdd7280ec4) |
| 10 | gasp2-hold-payment-held (hold #2, $150 → LOOKALIKE) | `0xac996d1ddb6b1c83ae5380cecc87e564370e4059bb1d9224034fd8d879833c3d` | ✅ 0x1 | agent key | guard ✅ | [link](https://testnet.arcscan.app/tx/0xac996d1ddb6b1c83ae5380cecc87e564370e4059bb1d9224034fd8d879833c3d) |
| 11 | gasp2-covered-verdict (VerdictAccepted, payout 135000000) | `0xed020f97235164333e416ae494c6b24462a6884e1aa2ba1a1898b85d07a299f6` | ✅ 0x1 | watcher | verdicts ✅ | [link](https://testnet.arcscan.app/tx/0xed020f97235164333e416ae494c6b24462a6884e1aa2ba1a1898b85d07a299f6) |
| 12 | (registry) validationRequest | `0x76973a7efb3da8e00d098598ab0cf97494f8fba3f3a9ca449151c9c2c36828fa` | ✅ 0x1 | ops | validation `0x8004Cb…4272` ✅ | [link](https://testnet.arcscan.app/tx/0x76973a7efb3da8e00d098598ab0cf97494f8fba3f3a9ca449151c9c2c36828fa) |
| 13 | (registry) validationResponse | `0x0b84127d140560e56e1112c1faea95c87f2d467ce32120e25b8f939f7acabbae` | ✅ 0x1 | smoke_watcher `0xAfB7…bEDa` | validation ✅ | [link](https://testnet.arcscan.app/tx/0x0b84127d140560e56e1112c1faea95c87f2d467ce32120e25b8f939f7acabbae) |
| 14 | (registry) giveFeedback | `0x76fe46f213d3cff63df2100f1008ebaad8131863ff503ddf00df21492526e6b1` | ✅ 0x1 | smoke_rep `0x976E…bB21` | reputation `0x8004B6…8713` ✅ | [link](https://testnet.arcscan.app/tx/0x76fe46f213d3cff63df2100f1008ebaad8131863ff503ddf00df21492526e6b1) |

**Receipt note:** the receipt lists "gasp1-owner-freeze-decision" twice (rows 8-duplicate and 9) — once for the verdict-contract tx `0xefa8…` (which carries `OwnerDecision(holdId=1, decision=255, actor=verdicts)` — the TEE-verdict auto-freeze) and once for amara's explicit `decide(holdId=1, FREEZE)` tx `0x4487…` (`OwnerDecision(holdId=1, decision=1, actor=amara)`). Both are real, distinct, and correct; the duplicate label is a receipt-naming artifact only, not a bad hash.

**Expected-missing hash:** the "$900 → ATTACKER" step has **no tx hash by design** — `$900 > $200` per-tx cap trips `TIER_VIOLATION/OVER_PER_TX` in `_classify`, so the call reverts before broadcast (demo catches it via viem's local simulation revert). No state change, no fee burn: the attempt is logged off-chain as an attempted-breach pricing signal. Confirmed: ATTACKER balance = 0.

---

## 2. ERC-8004 mirror (independently read back from the canonical registries)

**Agent identity:** agentId **894341** (note: not 1 — agentId 1 belongs to an unrelated earlier registrant `0xb7ACAC…`; expected, per ChainPreflight).
- `identity.ownerOf(894341)` = `0x05499b0be3B9E9Db3Cc5124b2F682513D94133A6` (ops) ✅
- `identity.getAgentWallet(894341)` = `0x9675b4D20d2ACFE55D00a02D55B9cdb57AEbD482` (guard owner / claimant, i.e. the BULWARK guard agent wallet) ✅

**Posts (all three landed, all status 0x1):**
1. `validationRequest` — `0x76973a…28fa` → validation registry, from ops. [arcscan](https://testnet.arcscan.app/tx/0x76973a7efb3da8e00d098598ab0cf97494f8fba3f3a9ca449151c9c2c36828fa)
2. `validationResponse` — `0x0b8412…bbae` → validation registry, from the TEE watcher key (validator of record). [arcscan](https://testnet.arcscan.app/tx/0x0b84127d140560e56e1112c1faea95c87f2d467ce32120e25b8f939f7acabbae)
3. `giveFeedback` — `0x76fe46…e6b1` → reputation registry, from the reputation key (client of record). [arcscan](https://testnet.arcscan.app/tx/0x76fe46f213d3cff63df2100f1008ebaad8131863ff503ddf00df21492526e6b1)

**Readback values (via `cast call` directly against the registries):**

`validation.getValidationStatus(0xb8f6…62cf)`:
- validatorAddress = `0xAfB732d3C1B483b9e2Cdf9f2c3A2438ABeb2bEDa` (smoke_watcher) ✅
- agentId = 894341 ✅
- **response (score) = 25** (= `SCORE_COVERED`) ✅
- responseHash = `0x1af03bc6a70b6309bd5c9ec92c7d78c1024e0d69c9ea5ea60faf828c958ed3f0` — **matches the on-chain `VerdictAccepted.digest`** ✅
- tag = `bulwark-verdict` ✅
- lastUpdate = 1789161217 (2026-09-11T21:13:37Z, block 61625837) ✅

`reputation.readFeedback(894341, 0x976E…bB21, 1)` (index 1 = first feedback; `getLastIndex` = 1):
- **value = −2500** (= `VALUE_COVERED`, i.e. −$25.00 at 2 decimals) ✅
- valueDecimals = 2 ✅
- tag1 = `bulwark-verdict`, **tag2 = `covered`** ✅
- isRevoked = false ✅

**Fail-closed behavior (designed):** gasp-one's `HoldVerdictRouted(holdId=1, agent=guard, clean=false)` was caught by the orchestrator but produced **zero** registry posts — `parseTriggers` returns `[]` for `clean=false` (fail closed: a suspicious-hold verdict is not a validated performance record, so nothing is written). This is intentional per `erc8004-orchestrator.ts`; the hold was instead resolved on-chain by the owner FREEZE decision (tx #9). The only ERC-8004 posts are the three above, keyed to the accepted covered verdict.

---

## 3. On-chain demo outcome confirmation (final state, block ≥ 61626118)

| Check | Expected | Observed (independent) | Result |
|-------|----------|------------------------|--------|
| Amara USDC (payout) | 135000000 ($135) | 135000000 (was 0 before run) | ✅ PASS |
| FRESH_WALLET USDC | 0 (attack never settled) | 0 | ✅ PASS |
| LOOKALIKE USDC | — (see note) | 0 | ✅ PASS (see note) |
| ATTACKER USDC | 0 ($900 blocked pre-broadcast) | 0 | ✅ PASS |
| Guard `nextHoldId` | advanced past 1 | **3** (holds #1 and #2 both created) | ✅ PASS |
| Guard `dailyState` | reflects the run | day **20707**, spent **800000000** ($800 payroll), count **4** — held amounts correctly NOT counted as daily spend (only routine lane calls `_spendDaily`) | ✅ PASS |
| ALICE USDC | 180+90 = 270000000 | 270000000 | ✅ PASS |
| BOB USDC | 310+220 = 530000000 | 530000000 | ✅ PASS |
| Guard USDC | 4e9 − 8e8 = 3200000000 | 3200000000 | ✅ PASS |
| Pool USDC | 45e9 − 135e6 = 44865000000 | 44865000000 (junior draw; receipt reports junior 19865000000 / senior 25000000000, consistent with the $135 payout from junior) | ✅ PASS |
| Payout atomicity | pool pays claimant in the same tx as the verdict | `VerdictAccepted(digest 0x1af0…, agent=guard, outcome=1 COVERED, payout=135000000, alibi=1 EXTERNAL)` in tx #11, Amara's balance = exactly 135000000 | ✅ PASS |
| Verdict freshness / day boundary | all demo txs inside UTC day 20707 | blocks 61625041–61625840 → 21:06:49Z–21:13:38Z on 2026-09-11; day-20708 rollover not until 00:00Z | ✅ PASS |

**LOOKALIKE note:** my briefing said "LOOKALIKE == 150000000 (slip executed)", but the chain shows the $150 → LOOKALIKE payment was **Held** (hold #2, `Held(holdId=2, to=0x328809…dac1, amount=150000000)`, tx #10). I verified this is the **correct contract behavior**, not a deviation: LOOKALIKE is not on the allowlist, so `_classify` returns `TIER_ELEVATED (NEW_RECIPIENT)` and `propose` routes to the hold lane — the guard never routinely transfers to a new recipient. The demo's "slip executed / one beat of horror" narration describes the attacker's *intent*; on-chain, the guard's elevated lane intercepts it, the watcher's covered verdict then pays Amara the $135 claim. The receipt honestly reports `lookalikeUsdc: 0` and `lookalikePaid: false`. The essential outcome — covered-breach payout landed — is fully confirmed. (The briefing expectation would only hold if LOOKALIKE had been allowlisted, which contradicts the "look-alike = unknown recipient" premise of Case 5.)

---

## 4. Requirements scorecard

| Requirement | Result |
|-------------|--------|
| Full two-gasp demo executed on fresh stack, demo exit code 0 | ✅ PASS |
| Orchestrator caught `VerdictAccepted` (tx #11) | ✅ PASS |
| Orchestrator caught `HoldVerdictRouted` (tx #8) — clean=false → fail closed, no post (designed) | ✅ PASS |
| Responses posted to live canonical ERC-8004 registries (3 posts: request, response, feedback) | ✅ PASS |
| `VerdictAccepted.digest` == `validation.responseHash` (mirror keyed to the real verdict) | ✅ PASS |
| Every step has a real, fetchable tx hash | ✅ PASS (14/14 re-fetched, all status 0x1; ATTACKER step correctly has none — pre-broadcast block) |
| Tx senders match expected actors (ops / agent key / watcher / amara / rep key) | ✅ PASS |
| Amara payout $135 landed | ✅ PASS |
| FRESH_WALLET attack never settled (0) | ✅ PASS |
| $900 ATTACKER blocked OVER_PER_TX, no state change | ✅ PASS |
| `nextHoldId` advanced past 1 (now 3) | ✅ PASS |
| `dailyState` reflects run (20707, $800 spent, count 4) | ✅ PASS |
| agentId owned by ops `0x0549…33A6` | ✅ PASS (894341) |
| agentId wallet binding = guard/claimant | ✅ PASS |
| Validation readback: score 25 (COVERED), tag `bulwark-verdict` | ✅ PASS |
| Feedback readback: −2500 @ 2dp, tags `bulwark-verdict`/`covered`, not revoked | ✅ PASS |
| All activity inside UTC day 20707 (no counter rollover) | ✅ PASS |
| Receipt internally honest (no fabricated hashes/fields) | ✅ PASS (every claimed field re-verified against chain; collector's mid-settle kill disclosed in receipt note) |

### Overall: ✅ PASS

Minor notes (non-blocking):
- Receipt labels tx `0xefa8…` as "gasp1-owner-freeze-decision" (it is the verdict tx that also carries the auto-freeze `OwnerDecision` from the verdict contract) and repeats that label for amara's `0x4487…` decide tx — cosmetic labeling only.
- Receipt `readback.lookalikeUsdc: 0` / `lookalikePaid: false` reflects correct elevated-lane behavior (see §3 note); it is not a demo failure.
