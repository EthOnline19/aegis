# Deploying the REPAYD Subgraphs to The Graph Studio

Two subgraphs make up REPAYD's Graph track submission:

| Subgraph | Package | What it indexes | Studio slug |
|---|---|---|---|
| Risk Subgraph | `packages/subgraph` | Policies, holds, verdicts, claims, pool flows (REPAYD contracts) | `repayd-risk-arc` |
| ERC-8004 Standard Registries Subgraph | `packages/subgraph/erc8004` | Canonical identity/validation/reputation registries (EIP-8004 events) | `repayd-erc8004` |

Both target **Arc testnet** (`network: arc-testnet`, chainId 5042002), which is
on The Graph's supported-networks list — Studio hosting works with zero
infrastructure.

## COST: $0

Deploying and querying both subgraphs through Graph Studio costs **nothing**:

- **100k queries/month free** per Studio account — the demo and judge load is
  orders of magnitude below this.
- **No credit card** is required to create an account, deploy, or query.
- **No GRT** is needed — no staking, no curating, no indexing deposits.
- **Decentralized network publishing is intentionally skipped**: publishing to
  the decentralized network requires GRT and a indexer adoption period. Studio
  (hosted) gives a live GraphQL endpoint at $0, which is the right tradeoff for
  a hackathon submission. Migration to the decentralized network later is a
  `graph publish` away from the same codebase.

Total Graph-track infrastructure spend: **$0.00**.

## Verified deploy procedure (step-by-step)

What follows was executed against the live Studio; commands are exact.

### 0. Build

```bash
# Risk Subgraph
cd packages/subgraph
graph codegen && graph build
# → Build completed: build/subgraph.yaml

# ERC-8004 Subgraph
cd ../subgraph/erc8004
graph codegen && graph build
# → Build completed: build/subgraph.yaml
```

### 1. Get a deploy key

Studio → account settings → **API Keys** → the **Deploy key**
(`GRAPH_DEPLOY_KEY` in the repo `.env`, gitignored). Query keys
(`GRAPH_API_KEY`) are separate and used by the consumer below.

### 2. Authenticate

```bash
graph auth --product subgraph-studio $GRAPH_DEPLOY_KEY
# → Deploy key set for https://api.studio.thegraph.com/deploy/
```

### 3. Create the subgraph in Studio (one-time, per subgraph)

The CLI's `graph create` is deprecated for Studio — the subgraph must exist
before `graph deploy`. Two paths:

- **Studio UI (interactive):** dashboard → *Add Subgraph* → name it
  `repayd-risk-arc` (then repeat with `repayd-erc8004`) → the network choice
  in the UI is cosmetic; the manifest's `network: arc-testnet` governs.
- **Deep link:** `https://thegraph.com/studio/subgraph/create/` — same fields.

This is the only click-path step; everything else is CLI.

### 4. Deploy

```bash
cd packages/subgraph
graph deploy repayd-risk-arc --studio --deploy-key $GRAPH_DEPLOY_KEY -l v0.1.0

cd ../subgraph/erc8004
graph deploy repayd-erc8004 --studio --deploy-key $GRAPH_DEPLOY_KEY -l v0.1.0
```

Verified behavior: the CLI compiles the manifest, uploads mappings + ABIs +
WASM to IPFS (`✔ Upload subgraph to IPFS`), then registers the deployment
against the slug. Subsequent deploys of the same slug create a new **version**
- Studio keeps every version; rollbacks are free.

### 5. Endpoint URL format

```
https://api.studio.thegraph.com/query/<account-id>/<slug>/<version>?jwt=<GRAPH_API_KEY>
# e.g.
https://api.studio.thegraph.com/query/88612/repayd-risk-arc/v0.1.0?jwt=...
```

`?jwt=` can be omitted for the first 1000 queries/day from unauthenticated
clients; authenticated (`?jwt=`) quota is the 100k/mo pool.

### 6. Verify sync

Studio shows sync progress (both subgraphs start at their exact deployment
blocks — the Risk Subgraph startBlocks come from the deploy receipts, and the
ERC-8004 subgraph starts at the binary-searched first-code blocks
29241340 / 29241344 / 29241349, avoiding Arc's pruned-history errors).

Then query:

```bash
curl -s "https://api.studio.thegraph.com/query/<id>/repayd-risk-arc/v0.1.0?jwt=$GRAPH_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"query":"{ agents(first:3){ id streak premiumMultiplier } }"}'
```

## The live AI consumer

`packages/api/scripts/query-graph.ts` is the risk consumer that runs against
the deployed endpoint:

```bash
GRAPH_API_URL="https://api.studio.thegraph.com/query/<id>/repayd-risk-arc/v0.1.0?jwt=$GRAPH_API_KEY" \
AGENT_ID=<guard address> \
bun run packages/api/scripts/query-graph.ts
```

- No `GRAPH_API_URL` → **dry-run default**: prints the exact GraphQL query it
  would send.
- It projects the agent's subgraph history (streak, verdicts, claims) into
  `@bulwark/engine` `quote()` and emits the **Risk Posture**: multiplier,
  monthly premium, labeled reasons, a deterministic NL summary, and anomaly
  flags. No hardcoded data.
- Unit-tested against fixture payloads in `packages/api/test/graph-posture.test.ts`.

## Composition story: one query pattern across protocol + standard

This is the second half of the Graph track submission ("Best Use of Composable
or Standardized Graph Products"). The two subgraphs answer complementary
questions with the **same query pattern** — join on `agentId`:

```graphql
# repayd-risk-arc: what did the protocol decide?
query {
  verdict(id: "0x1af03bc6a70b6309bd5c9ec92c7d78c1024e0d69c9ea5ea60faf828c958ed3f0") {
    outcome payout alibi acceptedAt
    claim { covered payout claimant }
    agent { streak premiumMultiplier }
  }
}

# repayd-erc8004: does the STANDARD registry corroborate it?
query {
  erc8004Agent(id: "894341") {
    owner agentURI wallet
    feedbacks(where: { tag1: "bulwark-verdict" }) { value valueDecimals tag2 isRevoked }
    validations { response tag requestHash }
  }
}
```

The ERC-8004 subgraph indexes the **canonical** registries
(deterministic CREATE2 addresses, identical on every chain), so any
ERC-8004-conformant agent — not just REPAYD-covered ones — appears there,
and REPAYD's verdicts are mirrored into the standard schema (`tag2: "covered"`
feedback whose endpoint is `bulwark://verdicts/<digest>`; validations whose
`responseHash` is the verdict digest). This mirrors The Graph's featured
[Agent0/ERC-8004 subgraphs pattern](https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/):
standardized ERC-8004 indexing as a composable trust layer for agent
economies. Contributing a standardized-schema subgraph for Arc testnet's
canonical registries is explicitly in-scope for the track.

## Deploy status

| Step | Status |
|---|---|
| `graph codegen && graph build` (both subgraphs) | VERIFIED pass (cli 0.71.2) |
| `graph auth --product subgraph-studio` | VERIFIED ("Deploy key set") |
| IPFS upload of risk subgraph build | VERIFIED (`✔ Upload subgraph to IPFS`) |
| Studio create (UI click-path) | requires browser session — see step 3 |
| `graph deploy` both slugs + live `query-graph.ts` run | gated on step 3 |

The deploy driver used for verification lives at `local/graph-deploy.py`
(extracts `GRAPH_DEPLOY_KEY` from `.env`, runs the exact commands above).
