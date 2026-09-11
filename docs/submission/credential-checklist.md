# REPAYD — Credential Checklist (priority order)

Every `[NEEDS:*]` item across the submission docs, with owner and what it unblocks. Priority = first-place impact per hour of waiting: the Graph deploy key alone unblocks **two** $5,000 tracks' live-data gates; Hedera unblocks the $6,000 track's core requirement; Circle is an enhancement on a track that is already largely DONE; ENSv2 is a discovery extra-credit; the Arc mainnet decision gates $2,500.

| Pri | Credential / decision | Owner | Unblocks | Tracked as | Status |
|-----|----------------------|-------|----------|-----------|--------|
| **C1** | **The Graph Subgraph Studio deploy key** (create subgraph at thegraph.com/studio, e.g. "Repayd Risk Arc Testnet", grab deploy key) | GraphDeploy agent → needs key from Main/user | `graph auth` + `graph deploy` of the Risk Subgraph to `arc-testnet`; the live Studio endpoint for the API, pricing engine, résumé builder, and AI risk-posture consumer; **unblocks BOTH Graph tracks' "live provider data" gates (G2/S2)** and the GRAPH video recording (GRAPH-2..9) | `[NEEDS:GRAPH_DEPLOY_KEY]` | **BLOCKED-ON-CRED** |
| **C2** | **Hedera testnet accounts** (2× ECDSA via portal.hedera.com, faucet-funded: operator/payer `HEDERA_OPERATOR_ID`+`_KEY`, service/payTo `HEDERA_SERVICE_ID`+`_KEY`; no Blocky402 key needed — hosted testnet facilitator is open access) | HederaX402 agent → needs keys from Main/user | Bring `packages/hedera` service live; execute the first REAL paid request end-to-end (`scripts/paid-request.ts`); HCS audit topic; `schedule-premium.ts` recurring settlement; **unblocks the Hedera track's core requirements (H1–H4) and video (HEDERA-2..9)** | `[NEEDS:HEDERA_TESTNET_KEYS]` | **BLOCKED-ON-CRED** |
| **C3** | **Circle API key** (Circle Platform / Agent Stack console) | ArcAgentStack agent → needs key from Main/user | Direct Circle Agent Stack / Wallets / Paymaster / Nanopayments integration calls in the payment flow (matrix A3/A4 live-API cells); strengthens the "effective use of Circle's Developer tools" gate | `[NEEDS:CIRCLE_API_KEY]` | **BLOCKED-ON-CRED** (track largely DONE without it) |
| **C4** | **Arc MAINNET deploy decision** — fund a mainnet deployer, run `Deploy.s.sol` against Arc mainnet, re-run demo on mainnet stack | Main (human decision) + Step4-style run | The **$2,500 mainnet rider** of the $3,500 Arc bounty (deploy by **Sept 30, 2026**). Contracts + deploy script are chain-agnostic and ready (`514f5eb`); decision needed on cost/risk | `[NEEDS:ARC_MAINNET_DECISION]` | **NEEDS DECISION** — flagged in compliance matrix A9 |
| **C5** | **Sepolia ETH + MockUSDC** (faucet ETH for gas; MockUSDC for the record package's gated scripts) | ResumeBuilder/record work → needs funds | Register the ENSv2 name (e.g. `atlas.repayd.eth`) via commit-reveal + PermissionedResolver, resolve the public résumé; unblocks Hedera extra-credit "agent discovery via UCP or a directory" (H7) and the ENSv2 first-mover story | `[NEEDS:SEPOLIA_FUNDS]` | **BLOCKED-ON-CRED** |
| **C6** | (implicit) Arcscan/HashScan are public; no keys needed for verification reads | — | None — all evidence readbacks in the matrix are public RPC + explorer | — | N/A |

### Sequencing note
- C1 first: one key, two tracks. The moment it lands: deploy, wait for sync, record GRAPH video, update matrix G2/S2 → DONE.
- C2 second: keys land → deploy service → one rehearsal paid request → record HEDERA video → update H1–H4.
- C3/C5 in parallel with recording; C4 is a pure decision — the earlier it's made, the more runway before the Sept 30 hard deadline.

### Where these appear in the docs
- `docs/submission/compliance-matrix.md` — rows G2/S2 (C1), H1–H4 (C2), A3/A4 (C3), A9 (C4), H7 (C5).
- `docs/submission/video-scripts.md` — recording prereqs: GRAPH (C1), HEDERA (C2); ARC records with zero new credentials.
- `README.md` — "What needs credentials" section.
