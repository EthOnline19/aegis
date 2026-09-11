# REPAYD Risk Subgraph (§13)

The public memory of the REPAYD protocol on **Arc testnet (chainId 5042002)**: every policy, tier decision, hold, verdict, claim, strike, and pool flow across all six fresh-stack contracts. A **public good** — the verdict pipeline and the pricing engine (§36) both consume this subgraph instead of running their own indexers.

## What it indexes

| Contract | Address | startBlock | Events |
|---|---|---|---|
| USDCMock | `0xb95fe4d7EEDb98693ded8F3c1a34A59F6Dac114B` | 61614321 | Transfer, Approval |
| PolicyRegistry | `0xcC34D02877E13Bf35Ad7E4eBC747d431B76e748a` | 61614324 | PolicyUpdated, PolicyRevoked |
| Blocklist | `0x19afa08179eD7De19a0e45FC35362A663ACa8322` | 61614329 | Reported, Cleared, AdminChanged, ReporterSet |
| VerdictContract | `0x7B46f82B37458771Bc88f79e5642e8AEFE2AC52f` | 61614331 | VerdictAccepted, HoldVerdictRouted, AttemptedBreachSignal, Reopened, Escalated*, ArbitrationConcluded*, StrikeRecorded, WatcherSet, PoolSet, ArbiterSet |
| MutualPool | `0x35d78e526cB230Eaa287AFe622f25DEB07B772e4` | 61614333 | Deposited, Redeemed, Payout, PremiumRecorded, LossApplied, ReinsuranceHooked, VerdictContractSet |
| GuardAccount | `0xB30553e2f132126B951D3a6AD4E07EbAa5523b6E` | 61614335 | Classified, Held, Released, OwnerDecision, ExecutedRoutine, ViolationBlocked, AttemptedBreach, AuthorityRevoked, AgentKeyRotated, HoldLapsed, Withdrawn, VerdictContractSet, Received |

\* Escalated / ArbitrationConcluded are v2 events (not emitted in v1) — handlers kept so the subgraph is forward-compatible without redeploy.

**All 36 events** across the six contracts are enumerated from `contracts/src/*.sol` (not guessed); signatures in `subgraph.yaml` are the canonical ABI form verified by `graph codegen`.

Start blocks are the **exact deployment blocks**, recovered from `contracts/broadcast/Deploy.s.sol/5042002/run-latest.json` receipts (address-matched against `contracts/deployments/5042002.json`). This matters: Arc testnet's public RPC **prunes genesis history** and caps `eth_getLogs` at ~30k blocks/call — never use `startBlock: 0` (error 4444 pruned history).

## Entities

Core: `Agent` (guardAddress, streak, premiumMultiplier, totals), `Policy` (agent, version, policyHash, cap, perTx, daily, velocity, allowlist — hydrated live via `PolicyRegistry.getPolicyView` since `PolicyUpdated` emits only the hash), `Transaction` (txHash, to, amount, txTier), `Hold` (lifecycle Held→Released/OwnerDecision/Frozen), `Verdict` (digest, outcome, payout, alibi), `Claim` (digest, payout, claimant, covered/denied), `BlocklistEntry` (destination, strikes, evidence), `PoolFlow` (type, amount, tranche), plus derived `RecipientCap`, `Report`, `Transfer`, `PoolState`.

### Derived updates (the "read replica with arithmetic")

- `Agent.streak` **increments on `ExecutedRoutine`** and resets on ViolationBlocked / AttemptedBreach / AuthorityRevoked / VerdictAccepted(COVERED|ATTEMPTED_BREACH) — the §12 clean-streak that drives streak discounts up to −60% at 180 days.
- **Claims recorded on `VerdictAccepted`**: `COVERED` → claim with payout + `paidAt`; `DENIED_OWNER_ORIGIN` → claim scar (denied=true, payout 0). `MutualPool.Payout` later pins the actual on-chain claimant and amount.
- **Strikes on `Reported` / `StrikeRecorded`**: `BlocklistEntry.strikes` maintained, `flagged` at ≥3 (hard flag); `Cleared` zeroes and marks cleared.
- **Hold lifecycle**: `Held` (pending) → `Released` / `OwnerDecision` (approve=3, freeze=4, freeze+rotate=5, watcher-frozen 0xFF=6, auto-frozen 0xFE=7) / `HoldVerdictRouted` (clean=false → frozen).

## Build

```bash
cd packages/subgraph
bun install        # installs @graphprotocol/graph-cli 0.71.x + graph-ts 0.35.x
bunx graph codegen # generates ./generated (gitignored)
bunx graph build   # compiles WASM → ./build/subgraph.yaml (gitignored)
```

Both commands verified passing in this repo (WSL `Ubuntu-Jashan`, bun 1.4.2). The root script `bun run subgraph:build` runs the same pair.

## Deploy recipe (The Graph — Arc testnet is officially supported)

Arc testnet (`eip155:5042002`, network identifier **`arc-testnet`**) is on The Graph's supported-networks list — no self-hosting needed. Source: https://thegraph.com/docs/en/supported-networks/arc-testnet/

```bash
# 1. Create the subgraph at https://thegraph.com/studio (connect a wallet,
#    Title Case name, e.g. "Repayd Risk Arc Testnet") — grab the deploy key.
# 2. Install the pinned CLI (verified on npm):
npm install -g @graphprotocol/graph-cli@0.98.1
# 3. Auth:
graph auth <DEPLOY_KEY>
# 4. In packages/subgraph (network: arc-testnet already set in subgraph.yaml,
#    per-contract startBlocks already set to exact deploy blocks):
graph codegen && graph build
# 5. Deploy:
graph deploy <SUBGRAPH_SLUG>
```

- Studio deploys are indexed by the Upgrade Indexer (Edge & Node), free, rate-limited — fine for the demo. The queryable endpoint is `https://api.studio.thegraph.com/query/<id>/<slug>/<version>`.
- Publishing to the decentralized network (on-chain publish + GRT curation) is optional and skipped for the demo.
- Credential gap: only a **Studio deploy key** (generated in Studio after creating the subgraph).

### Fallbacks (if Studio rejects)

- **Goldsky** supports Arc testnet (docs.goldsky.com/chains/arc) — same manifest, their CLI.
- **Sentio** lists `arc-testnet` (docs.sentio.xyz) — subgraph-format indexing.
- **Self-hosted graph-node**: `git clone https://github.com/graphprotocol/graph-node && cd docker`, set `ethereum = arc-testnet:archive:https://rpc.testnet.arc.io` in docker-compose, `docker-compose up` → GraphQL at `http://localhost:8000/subgraphs/name/<name>`. The public RPC serves `eth_getLogs` (graph-node auto-chunks under the ~30k-block range cap); no firehose needed for plain event subgraphs.

## §36 story — why this exists

> The Graph ($15k track, AI use case): the verdict pipeline and the pricing engine consume the Risk Subgraph, shipped as a public good. ENSv2 ($5k): insurance résumés + hash-chain heads, first movers.

The pricing engine (`packages/pricing`) reads clean-day streaks, attempted breaches, claims, and mitigations from this subgraph's entities (via `PricingEvent`s projected from `Agent`/`Verdict`/`Claim`/`BlocklistEntry`); the résumé builder (`packages/record`) reads the same state to render the §13 INSURED/DRIVING/CLAIMS/ALIBI/BACKING/STATUS block. Neither re-indexes the chain — the subgraph is the single shared read replica, and anyone can query it.

## Repo layout

```
packages/subgraph/
├── schema.graphql   # entities (committed)
├── subgraph.yaml    # 6 dataSources, arc-testnet, exact startBlocks (committed)
├── src/mapping.ts   # handlers for all 36 events (committed)
├── abis/            # fresh forge artifacts of the 6 contracts (committed)
├── generated/       # graph codegen output (gitignored)
└── build/           # compiled WASM (gitignored)
```
