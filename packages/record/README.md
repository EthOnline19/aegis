# @repayd/record — the ENSv2 insurance résumé

> `resolve repayd.eth` → the agent's full public insurance résumé.
> Any marketplace, any employer, any other agent — **one lookup prices trust in the machine.**
> (Master plan §13, §35.)

```
INSURED  : yes · policy v4 · cap $2,500 · pool healthy [VERIFIED]
DRIVING  : 94/100 · 179-day clean streak · premium 0.72x [COMPUTED]
CLAIMS   : 1 covered ($135) · 1 attempted (frozen, no loss) [VERIFIED]
ALIBI SDK: installed (instruction chain live) [VERIFIED]
BACKING  : World-ID verified human [VERIFIED]
STATUS   : ACTIVE [VERIFIED]
```

Every field carries a provenance label — **VERIFIED** (read from signed,
public, on-chain state) or **COMPUTED** (a published formula's output).
Nothing is ever INFERRED.

## Layout

- `src/resume.ts` — chain-independent core: `buildResume(input)` → the §13
  résumé object; `renderResume` (terminal block), `toEnsTextRecords` /
  `fromEnsTextRecords` (round-trip through `com.bulwark.*` text keys).
  Deterministic: no network, no clock, no randomness.
- `src/pricing.ts` — the `@repayd/pricing` shared contract:
  `computePremium(policy, events)` types, runtime engine load, and the §12
  formula invariant (`base_rate × coverage_cap × product(multipliers)`).
- `src/ensv2.ts` — the ENSv2 Sepolia writer/resolver (see below).
- `scripts/register.ts` — **dry-run by default** registration writer.
- `scripts/resolve.ts` — read-only resolver, prints the résumé with provenance.

## The ENSv2 flow (Sepolia beta — verified by track research)

Fresh `.eth` names on ENSv2 Sepolia use commit-reveal registration and
**cannot** use PublicResolverV2 for text records (its auth requires the v1
NameWrapper). Our path:

1. **Deploy a PermissionedResolver proxy** via the VerifiableFactory
   (`initialize(owner, ALL_ROLES, setters)`) — the résumé's `setText` calls
   are baked into the `setters` array, so the records land in the *same
   transaction* as the resolver deploy.
2. **Approve** MockUSDC (registration is ERC20-only; ~8 MockUSDC for 1yr of
   a 5+char label).
3. **Commit** — `keccak256(abi.encode(label, owner, secret, subregistry,
   resolver, duration, referrer))`, binding all 7 params (anti-frontrun).
4. **Wait 60s** (MIN_COMMITMENT_AGE), then **register**.

Text records: `com.bulwark.resume` (the full block),
`com.bulwark.chainhead` (alibi hash-chain head), plus one
`com.bulwark.<field>` key per §13 field. Resolution goes through the
UniversalResolverProxy; the inner `text()` return is ABI-decoded.

## Usage

```bash
# Dry run (default): prints the exact 4-tx plan + text records. Zero writes.
bun run scripts/register.ts repayd

# Read the résumé back (read-only, no env keys needed).
bun run scripts/resolve.ts repayd.eth

# Tests
bun test packages/record
```

### Gated execution

No transaction is ever sent unless **both** env keys are set:

| Env key | Purpose |
|---|---|
| `ENSETH_PRIVATE_KEY` | funded EOA — Sepolia ETH for gas + ~8 MockUSDC |
| `ENSV2_RPC_URL` | Sepolia RPC endpoint |

With the gate open, `register.ts` runs read-only preflight first
(`isAvailable`, `getRegisterPrice`, `balanceOf`) and aborts before any
write if the label is taken or the balance is short.

## §36 — the ENSv2 track story (first movers)

EN Sv2 at ETHOnline 2026: **$5k — Best Use of ENSv2.** The pitch: REPAYD
puts **insurance résumés + hash-chain heads on the brand-new ENSv2
registry — first movers** (zero of the 2,511 hackathon winners surveyed
have built on ENSv2). The record is the trust primitive of the agent
economy: a marketplace doesn't audit an agent's history, it resolves one
name. The alibi hash-chain head, committed continuously, makes the record
tamper-evident — any edit breaks the chain visibly.

## Credential gaps (before the live demo)

| Gap | Detail |
|---|---|
| **Sepolia ETH** for gas | 4 txs (deployProxy, approve, commit, register). Faucets: Google Cloud / Alchemy Sepolia faucet, ENS Discord `#faucet`. |
| **MockUSDC** payment token | `0x768f42455a2d082e23ceef7d51e5787c82d67a39` — ENS-team-deployed. ~8 tokens for 1yr of a 5+char label. **Mint path unverified** — check the contract for a public `mint()`; if gated, ask in ENS Discord. |
| Label availability | `atlas` is TAKEN on ENSv2 Sepolia; label availability for `repayd` to be re-verified post-rename. Subnames like `atlas.repayd.eth` inherit the parent resolver (wildcard resolution). |

Until those are funded, `register.ts` stays a dry run — which is the
default and the safe state.
