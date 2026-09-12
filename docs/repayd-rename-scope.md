# REPAYD Rename Scope — BULWARK → REPAYD

> Inventory generated 2026-09-12 via `grep -ri bulwark` (excluded: node_modules, contracts/lib, .git, packages/subgraph/abis, packages/subgraph/erc8004/abis).
> Note: `contracts/out/**`, `contracts/cache/**`, and `packages/subgraph/generated/**` / `build/**` are build artifacts, gitignored, and regenerate on rebuild — never hand-edited.

## Approved decisions (per Main)

### (a) LIVE ON-CHAIN STRINGS — STAY AS-IS
These are written on-chain from the verified Step-4 run (agentId 894341, digest 0x1af03bc6…, 14 txs all success). Renaming would orphan the live record and cross-check tooling.

| String | Location |
|---|---|
| `tag1: "bulwark-verdict"` | packages/sdk/src/erc8004/clients.ts:183, mapping.ts:13 (`TAG1`), api/src/erc8004-orchestrator.ts:310 (`TAG_RESPONSE`), api/scripts/arc-smoke.ts:162, docs/ERC8004_DESIGN.md (descriptive), docs/submission/* (descriptive), subgraph erc8004 README examples |
| `tag2: "covered"` | (already brand-neutral — listed for completeness; no change) |
| `bulwark://verdicts/<digest>` | packages/sdk/src/erc8004/mapping.ts:58-59 (`verdictEndpoint`), api/scripts/arc-smoke.ts:171, docs/ERC8004_DESIGN.md, subgraph erc8004 schema comment |
| `bulwark://agents/<…>.json` agent URIs (Step-4 posts) | packages/api/scripts/arc-smoke.ts:96, step4-arc.ts:275 — historical posted URIs; keep scripts byte-compatible with the verified run |
| `.wsl/step4-receipt.json`, `.wsl/step4-run.sh` | run artifacts of the verified live run — historical record, untouched |

### (b) SOLIDITY IDENTIFIERS — STAY (no .sol changes)
- `contracts/src/BulwarkTypes.sol` and every `BulwarkTypes.*` reference (contracts/src, contracts/test, contracts/script/Deploy.s.sol, TS mirror comments in packages/engine/src/types.ts, packages/api/src/coverage-bridge.ts, packages/subgraph/src/mapping.ts, engine/test/shared-types.test.ts — comments referencing the .sol filename stay accurate).
- `contracts/src/VerdictContract.sol` — `DOMAIN_NAME = "BULWARK VerdictContract"` (line 110) and `DOMAIN_SALT = keccak256("BULWARK.verdict-domain.v1")` (line 109): **deployed EIP-712 domain constants**. Changing them invalidates every signature from the live deployment. Explicitly NOT renamed.
- `contracts/test/BulwarkTest.t.sol` filename + contents.
- Descriptive comment in `contracts/src/VerdictContract.sol:461` referencing BULWARK_MASTER_PLAN.md — acceptable historical pointer; left untouched per no-.sol-changes rule.

### (c) EVERYTHING ELSE — RENAMES (phases)

**Phase 1 — docs (no code):**
- `BULWARK_MASTER_PLAN.md` → title/brand text to REPAYD (keep §-numbering; add rename note; historical `atlas.bulwark.eth` ENS examples in prose become `atlas.repayd.eth`). Filename stays (referenced by VerdictContract.sol comment; renaming the file would dangle that pointer).
- Root `README.md` (already has rename note; ComplianceFinish2 owns remaining polish), `docs/ERC8004_DESIGN.md` prose, `docs/submission/*.md` (ComplianceFinish2 owns), package READMEs (`packages/record/README.md`, `packages/subgraph/README.md`; `packages/subgraph/erc8004/README.md` — GraphFinish2 owns).

**Phase 2 — user-facing strings (code-adjacent, behavior-preserving):**
- `packages/api/src/server.ts` (banner line 211; ArcFinish2-committed base), `packages/api/src/store.ts` (header comments rename; **`*.bulwark.eth` record-name derivation at store.ts:58 STAYS** — data format matching live ENSv2 registrations), `packages/api/src/schemas.ts` (header).
- `packages/dashboard/src/{owner,capital,record}.html` + `serve.ts` (titles, headers, footers; sample-record ENS names `atlas.bulwark.eth` → `atlas.repayd.eth` in demo/sample data; `service: "bulwark-dashboard"` health string renames), env vars `BULWARK_API_PORT`/`BULWARK_DASH_PORT`/`BULWARK_API_URL` → `REPAYD_*` (update .env.example + consumers same commit).
- `packages/demo/src/demo.ts` banners/comments (agent names → `atlas.repayd.eth` etc.), `packages/engine/src/*` headers, `packages/record/src/*` + scripts (headers; **`com.bulwark.*` ENS text-record keys are LIVE DATA on Sepolia → STAY**, same class as (a): they key the registered bulwark.eth résumé), `packages/record/README.md`.
- `packages/subgraph/subgraph.yaml` + `schema.graphql` + `src/mapping.ts` descriptions ("BULWARK Risk Subgraph" → "REPAYD Risk Subgraph") — GraphFinish2 owns erc8004/ subdir only; main subgraph files are mine.
- `docs/ERC8004_DESIGN.md` prose (descriptive BULWARK → REPAYD; keep literal on-chain strings as quoted literals).

**Phase 3 — package namespace `@bulwark/*` → `@repayd/*`:**
- package.json `name` fields: api, dashboard, demo, engine, pricing (COMMITTED green — mechanical name-field-only edit allowed), record, sdk (name `@bulwark/agent-sdk`), subgraph, hedera (HederaFinish2).
- Import sites (~20 lines): packages/api/{src/store,src/erc8004-orchestrator,scripts/*}, packages/demo/{src/demo,src/protocol}.ts, packages/record/src/pricing.ts, packages/hedera/src/payloads.ts.
- `bun.lock` regen via `bun install` at root; full root `bun test`/vitest; tsc per package; graph build.
- ROLLBACK PLAN: if not green in 15 min → `git checkout -- packages bun.lock package.json` and report.

**CI (`.github/workflows/ci.yml`):** contains zero `@bulwark` references — no changes needed (verified).

## Ownership gates (live coordination)
- ArcFinish2: packages/api (server.ts, circle/) — committed 378978f; dashboard owner.html pending.
- HederaFinish2: packages/hedera (payloads.ts imports @bulwark/engine + @bulwark/record).
- GraphFinish2: packages/subgraph/erc8004 + new api files.
- ComplianceFinish2: docs/submission/* + README.md.
- Phase 3 starts only after Main relays all three finish-agent commit confirmations.
