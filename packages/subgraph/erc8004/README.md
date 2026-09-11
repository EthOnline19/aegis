# REPAYD ERC-8004 Standard Registries Subgraph (arc-testnet)

A **standards-aligned** subgraph indexing the **canonical ERC-8004 registries**
on Arc testnet (chainId 5042002) — the identity, validation, and reputation
singletons at their deterministic CREATE2 addresses:

| Registry | Address (identical on every chain) | First code on Arc (binary-searched `eth_getCode`) |
|---|---|---|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | block 29241340 |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | block 29241344 |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | block 29241349 |

Event signatures are the canonical ERC-8004 shapes from the EIP
(https://eips.ethereum.org/EIPS/eip-8004) — `Registered`, `URIUpdated`,
`MetadataSet`, `ValidationRequest`, `ValidationResponse`, `NewFeedback`,
`FeedbackRevoked` — not REPAYD-internal events. Any ERC-8004-conformant agent
registered on Arc shows up here, not just REPAYD-covered agents.

## Why: composition with the REPAYD Risk Subgraph

This is the **second Graph product** in the composition story (The Graph
"Best Use of Composable or Standardized Graph Products" track):

```
REPAYD Risk Subgraph (bespoke, this repo)      ERC-8004 Subgraph (this one)
  Verdict  0x1af0…d3f0 outcome=COVERED          NewFeedback  agentId 894341
  Claim    $135 payout, alibi=external            value −2500 @2dp, tag2 "covered"
  Agent    streak, holds, policies              ValidationResponse score 25
                                                     requestHash 0xb8f6…62cf
```

**One query pattern across both** = "did the standard registries corroborate
what the verdict ledger says?" The ERC-8004 mirror of REPAYD's Step-4 run
(agentId 894341, verdict digest `0x1af0…ed3f0`) is cross-checkable in a
single composed query:

```graphql
# REPAYD Risk Subgraph
query {
  verdict(id: "0x1af03bc6a70b6309bd5c9ec92c7d78c1024e0d69c9ea5ea60faf828c958ed3f0") {
    outcome payout alibi acceptedAt
    claim { covered payout claimant }
    agent { streak premiumMultiplier }
  }
}

# This subgraph — same agent, standard schema
query {
  erc8004Agent(id: "894341") {
    owner agentURI wallet
    feedbacks(where: { tag1: "bulwark-verdict" }) { value valueDecimals tag2 isRevoked }
    validations { response tag requestHash }
  }
}
```

The `tag1: "bulwark-verdict"` feedback and the validation with
`responseHash == verdict digest` are the standard-registry mirrors of the
bespoke verdict — one query pattern over two subgraphs, joined on `agentId`.

This is exactly the pattern The Graph's featured
[Agent0/ERC-8004 Subgraphs resource](https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/)
describes: standardized ERC-8004 indexing as a composable trust layer for
agent economies. Deploying this subgraph contributes a standardized-schema
indexer for Arc testnet's canonical registries — in-scope for the
Composable/Standardized track ("contributing a standardized subgraph counts").

## Schema

```
Erc8004Agent   — one per Registered: owner, agentURI, current agentWallet,
                 live feedback/validation counts, net trust sum (Σ values
                 normalized to valueDecimals), last activity.
Erc8004Feedback — one per NewFeedback: client, index, value/decimals, tags,
                 endpoint, URI/hash, revoked flag (FeedbackRevoked).
Erc8004Validation — one per ValidationRequest, enriched when the named
                 validator answers: response 0-100, tag, responseHash, URIs.
```

## Build

Same toolchain as the parent package:

```bash
cd packages/subgraph/erc8004
bun install && bunx graph codegen && bunx graph build
```

Deploy alongside the Risk Subgraph (see `docs/submission/graph-deploy.md`):
create a second Studio subgraph, `graph auth`, `graph deploy <slug>` — the
manifest already carries `network: arc-testnet` and exact first-code
startBlocks, so no deploy-time parameters are needed.

## Files

```
packages/subgraph/erc8004/
├── schema.graphql    # 3 entities above (committed)
├── subgraph.yaml     # 3 dataSources, arc-testnet, exact startBlocks (committed)
├── src/mapping.ts    # handlers for the 7 canonical events (committed)
├── abis/             # event-only fragments of the canonical interfaces (committed)
├── generated/        # graph codegen output (gitignored)
└── build/            # compiled WASM (gitignored)
```
