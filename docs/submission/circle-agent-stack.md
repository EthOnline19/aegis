# REPAYD × Circle Agent Stack — Integration Plan (Arc Track)

> Status: **LIVE — authenticated reads operational** (key valid as `TEST_API_KEY:`-prefixed 3-part form on `api.circle.com/v1/w3s/*`; `entityAppId`, wallet sets, wallets, Gateway balances all served live, checklist C3). Mutation calls (wallet create / one gated spend) additionally require `CIRCLE_ENTITY_SECRET` — one-shot registration; reset via console with the recovery file.
> This document is the research + ranked recommendation. The implementation lives in `packages/api/src/circle/agent-wallet.ts`.

## 1. What the judges ask for

Arc bounty ("Best Agentic Economy Application with Circle Agent Stack"): agents with clear decision logic tied to real signals; **autonomous spending/payments/settlement in USDC**; **use of Agent Stack to connect agents to wallets, USDC payments, onchain actions**; Nanopayments/Paymaster/App Kits where relevant. Qualification gates: functional MVP (working frontend AND backend + architecture diagram), video + docs, GitHub repo.

Our gap: REPAYD's core loop (GuardAccount → Watcher verdict → MutualPool payout → ERC-8004 mirror) is fully live on Arc testnet but contains **no literal Circle product touchpoint**.

## 2. What the Circle Agent Stack actually is (research, Sept 2026)

The Agent Stack is five components — **Agent Wallets, Agent Marketplace, Circle CLI, Nanopayments (Gateway), Circle Skills** — and the docs push a specific shape of integration: agents operate wallets **through the `circle` CLI** (no SDK surface), skills installed off disk, spending caps enforced **on the wallet itself**, not in agent code.

Key facts from primary sources:

| Component | What it is | Testnet? | Integration surface |
|---|---|---|---|
| **Agent Wallets** | User-controlled wallets (2-of-2 MPC, key shares never exposed to the agent), operated via `circle` CLI after email+OTP login. **Transactions are gas-sponsored** (capped). Provisioned automatically on login for all supported chains — including **`ARC-TESTNET`**. | Yes (`circle wallet login --testnet`) | CLI subprocess; non-interactive auth via `--init`/`--otp` request-ID flow |
| **Developer-Controlled Wallets** (Circle Wallets, programmatic) | Wallets under an **API key + entity secret** — no email/OTP, fully server-side. `@circle-fin/developer-controlled-wallets` SDK: `createWalletSet`, `createWallets({ blockchains: ["ARC-TESTNET"], accountType: "EOA" })`, `signTypedData`, `createContractExecutionTransaction`. | Yes | REST/SDK — the only fully non-interactive programmatic path |
| **Nanopayments (Gateway)** | Gasless sub-cent USDC payments to x402 APIs. Buyer deposits USDC into a Gateway balance via EIP-3009 authorization; batch settles onchain later. `@circle-fin/x402-batching` SDK (`GatewayClient`). **EOA only** (SCA unsupported — settlement verifies with `ecrecover`). | Yes (Gateway testnet API + Arc testnet domain 26) | SDK; needs a funded EOA |
| **Paymaster (ERC-4337)** | On Arc, gas is **USDC-native** (18 decimals). Sponsorship = deploy/operate your own ERC-4337 paymaster contract, or an EIP-3009 relayer. No hosted Circle paymaster API on Arc testnet for direct calls. | Contract-deploy path | We'd have to deploy our own — real work, real risk |
| **App Kits** | `@circle-fin/app-kit` SDK: Send/Bridge/Swap/Unified Balance, one-line calls (`kit.send({ chain: "Arc_Testnet", ... })`), viem adapter. | Yes | SDK; needs wallet control |

Sources (fetched 2026-09-12):
- Agent Stack overview: https://developers.circle.com/agent-stack
- Agent Wallets: https://developers.circle.com/agent-stack/agent-wallets · quickstart: https://developers.circle.com/agent-stack/agent-wallets/quickstart · supported chains (ARC-TESTNET listed): https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains · non-interactive auth: https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/authenticate
- Nanopayments: https://developers.circle.com/agent-stack/agent-nanopayments · buyer quickstart (Circle Wallets + x402 batching on ARC-TESTNET, Gateway domain 26, USDC-as-gas): https://developers.circle.com/gateway/nanopayments/quickstarts/buyer
- Developer-Controlled Wallets: https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet
- Starter kits (integration philosophy — "a shell, not an SDK surface"; caps on the wallet, not in the agent): https://github.com/circlefin/agent-stack-starter-kits
- Arc paymasters/relayers (USDC-native gas, EIP-3009 relayer vs ERC-4337 paymaster you operate yourself): https://docs.arc.io/integrate/relayers-and-paymasters
- App Kit: https://docs.arc.io/app-kit

## 3. Ranked recommendation

Scored by **credibility to judges × demoability × (1/risk)** for a hackathon closing soon:

### ★ Path A (RECOMMENDED, implemented): Circle Developer-Controlled Wallet as the agent treasury mirror
`packages/api/src/circle/agent-wallet.ts` — a config-gated module (`CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET`, never committed) that:
1. Creates (or reuses, via `CIRCLE_WALLET_SET_ID` / `CIRCLE_AGENT_WALLET_ADDRESS`) a **Circle Programmable (developer-controlled) Wallet on `ARC-TESTNET`** — the REPAYD agent's Circle-side treasury.
2. Reads the wallet's **USDC balance** via Circle's `listBalances` API and **mirrors the GuardAccount's live on-chain USDC balance** next to it — "the agent's insurance-backed balance, visible in Circle Wallets".
3. Supports **one USDC transfer** from the Circle wallet (`createTransaction`) — the "autonomous spending in USDC" tick, gated behind `CIRCLE_DEMO_SPEND=1`.
4. **Dry-run mode (default)**: prints the exact API calls it WOULD make; zero network traffic. Same gating pattern as the proven `coverage-bridge.ts` (null config = disabled, no throws on missing env).

- **Credibility**: high — a real Circle Wallets product call, the exact API the nanopayments quickstart builds on (`@circle-fin/developer-controlled-wallets` on `ARC-TESTNET`).
- **Demoability**: high — wallet address on screen, live balances side-by-side, one sponsored spend.
- **Risk**: low — read-mostly; the single spend is opt-in and capped by the wallet's balance.

### Path B (stretch, next if time): Nanopayment for the risk-posture report
Deposit USDC from the Circle wallet into Gateway and pay a sub-cent x402 request — REPAYD's own `/v1/atlas/overview` or the Hedera risk-posture service behind x402. Highest "agentic economy" story value (Nanopayments + x402 + USDC settlement in one flow), but needs a funded Gateway balance and a compliant seller endpoint — more moving parts than Path A. Blocked on the same `CIRCLE_API_KEY`.

### Path C (rejected for hackathon): self-operated ERC-4337 Paymaster on Arc
Arc has **no hosted paymaster API** — sponsorship means deploying and operating our own paymaster contract with USDC gas. Solid engineering story but days of work, new contract risk, and the Agent Wallets path already gives us gas-sponsored transactions ("Agent wallet transactions are gas-sponsored", agent-wallets docs) without any deploy. Cut.

### Path D (rejected): App Kit embed
`kit.send/unifiedBalance` are one-liners but duplicate what Path A does at the API level; App Kits shine for consumer UX (bridge/swap flows), not agent treasury. The dashboard (MVP surface) needs live chain state, not a swap widget. Cut.

## 4. Wiring into the MVP surface

- `GET /v1/atlas/overview` (new, in `packages/api/src/server.ts`): live Arc-testnet chain state — guard USDC balance, dailyState, nextHoldId, ERC-8004 mirror status for agentId 894341 (validation status + reputation feedback re-read from the canonical registries), pool tranches — all read-only via public RPC from the deployment record. Serves the "working backend" gate.
- `GET /v1/circle/agent-wallet` (new): the Circle Agent Stack touchpoint — dry-run payload when unconfigured, live Circle Wallets data when `CIRCLE_API_KEY` is set. The dashboard owner page renders both.
- `docs/submission/architecture.md`: full-stack mermaid diagram including the Circle Agent Stack touchpoint.

## 5. Env contract (never committed)

```
CIRCLE_API_KEY=            # from console.circle.com  [NEEDS:CIRCLE_API_KEY]
CIRCLE_ENTITY_SECRET=      # registered entity secret
CIRCLE_WALLET_SET_ID=      # optional — reuse instead of create
CIRCLE_AGENT_WALLET_ADDRESS=  # optional — reuse instead of create
CIRCLE_DEMO_SPEND=1        # opt-in single USDC transfer
```

Once C3 lands: `bun run packages/api/scripts/circle-agent-wallet.ts` (live) or just `bun run packages/api/src/server.ts` and hit `/v1/circle/agent-wallet`.
