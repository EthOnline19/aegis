# ERC-8004 Integration — Step 2 Design (v2, Arc testnet)

**Status:** Approved design-of-record (v2 mapping). Implementation: Step 3, test-first against local mocks.
**Step 1 verified inputs (canonical CREATE2 registries, Arc chain 5042002, all v`2.0.0`, verified live via `eth_getCode` + calls):**

| Registry | Address | Poster key |
|---|---|---|
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | ops key |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | reputation key |
| Validation | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | request: ops key · response: watcher key |

## 0. Decisions locked with you

1. **Off-chain orchestrator.** BULWARK contracts stay untouched. All ERC-8004 posts are separate transactions from three keys, triggered by `VerdictContract` events. Tamper-evidence lives in VerdictContract's own event ledger (append-only, EIP-712 domain-bound verdicts) — the ERC-8004 records are composable mirrors of it, cross-checkable via `requestURI`/`endpoint` links back to verdict digests.
2. **BULWARK ops key owns every agentId NFT.** `setAgentWallet(agentId, guardAccount)` publicly binds the identity to the protected wallet; custody of the NFT confers no fund custody (GuardAccount remains owner-controlled). Self-registration + owner-granted operator is the documented v2 path.

## 1. Agent identity mapping

- One ERC-8004 `agentId` per covered agent, minted by the ops key at onboarding: `IDENTITY.register(agentURI) returns (uint256 agentId)`.
- `IDENTITY.setAgentWallet(agentId, guardAccount)` — the registry's canonical agentId ↔ GuardAccount binding (owner-signed flow with 5-minute deadline, supports ERC-1271 wallets).
- **Confirmation of a valid binding** (used by the orchestrator and the API): `IDENTITY.getAgentWallet(agentId) == PolicyRegistry.getPolicy(guardAccount).owner` for the live policy on that GuardAccount.
- `agentURI` serves a JSON document with: agent name/description, endpoints, ENS name, GuardAccount + PolicyRegistry + VerdictContract addresses, OASF and `erc-8004` extension metadata. It doubles as the x402 agent-skills document (same file serves both standards).
- `atlas.bulwark.eth` (ENSv2) stays the human-facing name; ERC-8004 is the machine-composable layer. **Non-goal:** ENSv2 hash-chain head commits (plan §13, separate task).

## 2. Validation Registry = watcher verdicts

- **The validator is the watcher key** (`VerdictContract.watcher()` — the TEE job key). `validationResponse` requires `msg.sender == validatorAddress` (the address named in the request), so only the watcher can ever answer a BULWARK request. No other party — not admin, not governance — can forge a response.
- **Flow, per accepted verdict** (orchestrator listens to `VerdictAccepted(digest, agent, outcome, ...)`):
  1. Ops key: `validationRequest(validatorAddress=watcher, agentId, requestURI, requestHash)` — authorized because ops owns the agentId NFT.
  2. `requestHash = keccak256(abi.encode(agentId, guardAccount, txHash, digest, chainId))` — binds the 8004 request to the exact accepted verdict.
  3. `requestURI = https://api.bulwark.eth/v1/verdicts/<digest>` — anyone can cross-check the request against the VerdictContract ledger.
  4. Watcher key: `validationResponse(requestHash, score, responseURI, responseHash, tag)`.
  5. Consumer: `getValidationStatus(requestHash)` → checks `validatorAddress == watcher` → reads score. Or `getSummary(agentId, [watcher], tag)` for the aggregate. Consumers never parse our API; the registry is the interface.
- **Writes are one-time.** `validationRequest` reverts on requestHash reuse ("exists"); `validationResponse` is first-answer-final (no update path). Orchestrator is idempotent: skip if `getValidationStatus(requestHash)` doesn't revert.
- **Score mapping (0–100), authoritative:** the three signals BULWARK publishes (validation score, reputation value, internal pricing load) must rank event severity identically — fraud < claim-loss < attempt. Validation scores reflect *incident outcome quality* (how well the machine handled the event), which is why COVERED (containment worked, payout made) sits at 25 and not 0:
  - `COVERED` → **25** — agent was breached with real loss (bad) but containment + payout worked (not 0).
  - `ATTEMPTED` → **75** — attacked, defenses held, no loss (good).
  - `DENIED_OWNER_ORIGIN` → **0** — owner-signed breach; trust hit.
  - `DISMISSED` → never posted (non-violating loss, no signal; absent ≠ zero — `getSummary` only counts `hasResponse=true` entries, so unposted verdicts are simply absent).

## 3. Reputation Registry = the driving record

- One `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)` per accepted verdict, posted by the **reputation key** — a separate EOA that is neither NFT owner nor operator (the self-feedback guard `isAuthorizedOrOwner(client, agentId)` must be false).
- **Value mapping (int128, valueDecimals=2, |value| ≤ 1e38) — v2, approved.** Reputation and pricing answer different questions about the same events, so the two systems are allowed to differ in sign where their questions differ, but must never contradict each other on severity *ordering*:
  - `DENIED_OWNER_ORIGIN` → **−10000** (−100.00, the floor). Proven fraud against the pool — intent, not accident. Master plan: permanently scarred insurability; no recovery path in pricing either. Kept at the floor by design.
  - `COVERED` → **−2500** (−25.00). Reasoning: the pricing engine already draws the category boundary — a first paid claim is ×3 for 6 months then back to base (recoverable; the −60% clean-streak discount rebuilds within ~2 quarters), while fraud is a permanent scar. That is a difference of category (intent), not magnitude, so COVERED must sit in a clearly recoverable band well clear of the floor rather than at a midpoint implying fraud is merely "2× worse." −25 = one quarter of the floor: material enough to reflect the engine's biggest short-term signal (a 300% premium spike; −10 would understate it), recoverable as clean history accumulates, and composing correctly under repetition (see aggregation below: a second claim drives the aggregate to −50, tracking pricing's ×3→×5 repeat escalation, while never reaching the fraud floor).
  - `ATTEMPTED` → **+500** (+5.00). Reasoning: pricing answers "what is the expected loss going forward?" — being targeted genuinely predicts further attempts, so its +15%/30-day load is actuarially correct and stays. Reputation answers "did this agent's protection hold when actually tested?" — it did, which is real but single-data-point evidence. +5 is mild corroboration, not compensation: negligible next to the strong positive signal in this system (a 180-day clean streak earning −60% premium), and in absolute magnitude both records agree the event is minor (pricing: 0.15 × 2% base = +0.3% of cap for one month; reputation: +5 on a ±100 scale) — they differ only in sign, each correct for its own question. This deliberate divergence is documented here so reviewers see it was considered, not missed.
  - `DISMISSED` → never posted (same rule as §2).
- **Aggregation semantics (verified against the reference implementation, `ReputationRegistryUpgradeable.getSummary`):** the registry's summary helper **averages** (sum of `value × 10^(18−decimals)` normalized to WAD, divided by count, rescaled to the mode decimals) — it does NOT sum. Consequences, handled explicitly:
  1. The v2 reasoning's "second claim → −50" composition holds **only under a summing consumer**. `getSummary`'s average would instead pull a lone −25 back toward neutral as clean entries accumulate around it — silently breaking repeat-offense escalation. The design therefore does NOT rely on the raw value average to convey repetition.
  2. Repetition is conveyed by **count + tag2**, both first-class on-chain: `tag1 = "bulwark-verdict"` (indexed) filters to BULWARK's feedback; `tag2` = outcome string; `getSummary(agentId, [reputationKey], "bulwark-verdict", "")` returns `(count, avgValue)` — `count` of covered claims is the repetition signal, recoverable by any consumer in one call. Per-claim values remain individually readable via `readFeedback`/`readAllFeedback` (unaggregated).
  3. **BULWARK's own display (dashboard / résumé / Coverage API) computes a SUM, not the registry default:** `reputationSum(agentId) = Σ readAllFeedback(...).values` over `tag1="bulwark-verdict"`, non-revoked. The sum is the "net trust mass" reading: one −25 event dents it by exactly 25, a second by another 25 (→ −50), +5 containment events push it back up, and a −100 fraud entry dominates. The registry average is surfaced alongside as the "per-event quality" reading. Both are documented in the API so no consumer mistakes one for the other.
- `tag2` values: `covered` / `attempted` / `denied-owner-origin`.
- `endpoint = bulwark://verdicts/<digest>` — machine link back to the VerdictContract ledger.
- Index mapping is receipt-derived: the orchestrator maps `digest → feedbackIndex` from its own tx receipt (the next per-client feedbackIndex is not front-run-deterministic). No lookup assumes an index before our tx confirms. `revokeFeedback` is reserved for a proven-wrong verdict (dispute overturn), matching `dispute()`/`requestRerun()`.

## 4. Contract surface copied into the repo

Three MIT interface files (SPDX header + provenance comment pointing at the upstream commit), under `contracts/src/interfaces/erc8004/`:

- `IERC8004IdentityRegistry.sol` — `register`, `register(string)`, `setAgentURI`, `getMetadata`/`setMetadata`, `getAgentWallet`/`setAgentWallet`/`unsetAgentWallet`, `ownerOf`, `isAuthorizedOrOwner`.
- `IERC8004ValidationRegistry.sol` — `validationRequest`, `validationResponse`, `getValidationStatus`, `getSummary`, `getAgentValidations`, `getValidatorRequests`, `getIdentityRegistry`.
- `IERC8004ReputationRegistry.sol` — `giveFeedback`, `revokeFeedback`, `appendResponse`, `readFeedback`, `readAllFeedback`, `getSummary`, `getIdentityRegistry`.

Registry addresses live in one TS module (`packages/sdk/src/erc8004/addresses.ts`), Arc-first, keyed by chainId 5042002, with the mainnet pair noted for future use. No addresses are hardcoded in contracts — BULWARK contracts never reference ERC-8004 at all.

## 5. TS integration surface (new code, all under packages/)

- `packages/sdk/src/erc8004/` — typed clients: `registerAgent`, `bindWallet`, `postValidationRequest`, `postValidationResponse`, `postFeedback`, plus `requestHash(digest, ...)` derivation shared with tests.
- `packages/api/src/` — orchestrator loop: subscribes to `VerdictAccepted`, performs the §2 flow (request → response) and §3 feedback, idempotent per digest; env keys `OPS_KEY`, `WATCHER_KEY`, `REPUTATION_KEY` (watcher key already exists in demo wiring).
- Mocks for local tests: `ERC8004IdentityMock`, `ERC8004ValidationMock`, `ERC8004ReputationMock` in `contracts/test/mocks/` implementing the three interfaces above (only the functions we call, reverting on the same authorization rules).

## 6. Test plan (test-first, per repo discipline)

1. **Contract tests** (`contracts/test/Erc8004Integration.t.sol`): happy path request→response per outcome; authorization reverts (non-owner request, non-validator response, self-feedback revert); idempotency (double request reverts "exists"); score/value mapping pinned for all four outcomes; `getSummary` average semantics pinned (WAD normalize, divide-by-count) + sum-based `reputationSum` derivation demonstrated from `readAllFeedback`.
2. **Orchestrator tests** (`packages/api/test/erc8004-orchestrator.test.ts`): event → three posts, in order, with correct senders; skip-if-posted idempotency; unknown-outcome → no post (fail closed); DISMISSED → no post.
3. **Unit tests** (`packages/sdk/test/erc8004.test.ts`): `requestHash` derivation stability; client encodings (int128 value, decimals, tags) against registry ABI; binding confirmation logic; `reputationSum` helper over mocked feedback entries.

## 7. Sequencing to Arc (Step 4 preview, not started)

1. Local mocks green (Step 3).
2. Switch addresses module to Arc testnet; smoke-test on Arc: register one agent (`atlas` demo identity), post one validation round-trip from a fork-free RPC.
3. Only then wire the orchestrator against live `VerdictContract` deployment events.

## 8. Explicit non-goals (v1)

- No ENSv2 commits (plan §13 — separate task).
- No OASF skill evaluation, no validation-request marketplace participation (we are always requester + our watcher is always responder).
- No reputation aggregation UI (dashboard reads stay via Coverage API; consumers read registries directly).
- No `appendResponse` usage (client-response threads are v2).

## 9. Known gap (logged 2026-09-08)

- `VerdictContract.submitHoldVerdict` (contracts/src/VerdictContract.sol:354) never
  emits the declared `HoldVerdictRouted(uint256,uint256,address,bool)` event — the
  emission site is missing on-chain. The orchestrator
  (`packages/api/scripts/arc-orchestrator.ts`) subscribes to `HoldVerdictRouted` and
  its handle path is implemented + unit-tested, but it is NEVER exercised by a real
  on-chain event until the contract emits it. Any change-set touching
  VerdictContract MUST add `emit HoldVerdictRouted(...)` after the
  releaseHold/freezeHold branch (VerdictContract.sol:366-372) plus a test, or the
  hold→feedback-only path stays dead code.

## 10. Demo-only deployment centralization (logged 2026-09-10)

- The deploy script (`contracts/script/Deploy.s.sol`) deliberately uses ONE
  demo key (amara) as pool admin, USDC minter, GuardAccount owner AND policy
  owner simultaneously. This matches the tested demo wiring
  (`packages/demo/src/protocol.ts`) and is a **DEMO-ONLY simplification**.
- A real deployment MUST separate these roles: a multisig for MutualPool
  admin, a distinct per-agent policy owner (the payout claimant) rather than
  one shared demo owner, and a dedicated ops key for wiring calls.
- Same category of centralization question as the ERC-8004 ops-key decision
  (§0); answered proactively here rather than left to a judge/reviewer.
