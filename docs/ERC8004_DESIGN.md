# ERC-8004 Integration — Step 2 Design (v1, Arc testnet)

**Status:** Draft for approval. No integration code written yet.
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
- **Score mapping (0–100), authoritative:**
  - `COVERED` → **25** — agent was breached with real loss (bad) but containment + payout worked (not 0).
  - `ATTEMPTED` → **75** — attacked, defenses held, no loss (good).
  - `DENIED_OWNER_ORIGIN` → **0** — owner-signed breach; trust hit.
  - `DISMISSED` → never posted (non-violating loss, no signal; absent ≠ zero — `getSummary` only counts `hasResponse=true` entries, so unposted verdicts are simply absent).

## 3. Reputation Registry = the driving record

- One `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)` per accepted verdict, posted by the **reputation key** — a separate EOA that is neither NFT owner nor operator (the self-feedback guard `isAuthorizedOrOwner(client, agentId)` must be false).
- **Value mapping (int128, valueDecimals=2, |value| ≤ 1e38):**
  - `COVERED` → **−10000** (−100.00) — breached with real loss; strong negative.
  - `DENIED_OWNER_ORIGIN` → **−10000** (−100.00) — owner-signed breach; strongest negative.
  - `ATTEMPTED` → **+2500** (+25.00) — attacked, held; positive.
  - `DISMISSED` → never posted (same rule as §2).
- `tag1 = "bulwark-verdict"` (indexed, enables on-chain `getSummary` filtering), `tag2` = outcome string (`covered` / `attempted` / `denied-owner-origin`).
- `endpoint = bulwark://verdicts/<digest>` — machine link back to the VerdictContract ledger.
- Index mapping is receipt-derived: the orchestrator maps `digest → feedbackIndex` from its own tx receipt (the next global feedbackIndex is not front-run-deterministic). No lookup assumes an index before our tx confirms.

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

1. **Contract tests** (`contracts/test/Erc8004Integration.t.sol`): happy path request→response per outcome; authorization reverts (non-owner request, non-validator response, self-feedback revert); idempotency (double request reverts "exists"); score/value mapping pinned for all four outcomes.
2. **Unit tests** (`packages/sdk/test/erc8004.test.ts`): `requestHash` derivation stability; client encodings (int128 value, decimals, tags) against registry ABI; binding confirmation logic.
3. **Orchestrator tests** (`packages/api/test/erc8004-orchestrator.test.ts`): event → three posts, in order, with correct senders; skip-if-posted idempotency; unknown-outcome → no post (fail closed); DISMISSED → no post.
4. Full existing suite stays green before any commit (forge 74 + engine 30 + sdk 15 + api 12 + tsc ×3).

## 7. Sequencing to Arc (Step 4 preview, not started)

1. Local mocks green (Step 3).
2. Switch addresses module to Arc testnet; smoke-test on Arc: register one agent (`atlas` demo identity), post one validation round-trip from a fork-free RPC.
3. Only then wire the orchestrator against live `VerdictContract` deployment events.

## 8. Explicit non-goals (v1)

- No ENSv2 commits (plan §13 — separate task).
- No OASF skill evaluation, no validation-request marketplace participation (we are always requester + our watcher is always responder).
- No reputation aggregation UI (dashboard reads stay via Coverage API; consumers read registries directly).
- No `appendResponse` usage (client-response threads are v2).
