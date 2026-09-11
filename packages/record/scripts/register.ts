/**
 * register.ts — write the BULWARK insurance résumé to ENSv2 (Sepolia beta).
 *
 * DEFAULT: DRY RUN. Prints the exact transactions it WOULD send — the
 * resolver-proxy deploy (with the résumé baked into its init setters),
 * the MockUSDC approve, the commit, and the register — plus the text
 * records that land on-chain. Zero network writes.
 *
 * A transaction is sent ONLY when BOTH env keys are set:
 *   ENSETH_PRIVATE_KEY  — funded EOA (Sepolia ETH for gas + ~8 MockUSDC)
 *   ENSV2_RPC_URL       — Sepolia RPC endpoint
 *
 * Usage:
 *   bun run scripts/register.ts [label]     # default label: bulwark
 *   bun run scripts/register.ts bulwark
 *
 * Label availability on ENSv2 Sepolia (research §1.5, verified read-only):
 * "atlas" is TAKEN; "bulwark" and "atlasbulwark" are free.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { sepolia } from "viem/chains";
import {
  buildRegistrationPlan,
  createEnsv2PublicClient,
  ENSV2_ADDRESSES,
  executeRegistrationPlan,
  preflight,
  writerGate,
} from "../src/ensv2.ts";
import { buildResume, renderResume } from "../src/resume.ts";

// ------------------------------------------------------------------ //
//            The §35 demo résumé (post Step-4 run state)              //
// ------------------------------------------------------------------ //

const RESUME = buildResume({
  policy: { version: 4, capUsd: 2500, poolHealthy: true },
  driving: { cleanDays: 179, score: 94, premiumMultiplier: 0.72 },
  claims: { covered: 1, attempted: 1, payoutsUsd: [135] },
  alibi: { installed: true, instructionChainLive: true },
  backing: { worldIdVerified: true },
  status: "ACTIVE",
});

/** Alibi hash-chain head — replaced by the SDK's live head when wired. */
const CHAIN_HEAD = `0x${"ab".repeat(32)}` as `0x${string}`;

// ------------------------------------------------------------------ //

async function main(): Promise<void> {
  const label = process.argv[2] ?? "bulwark";
  const gate = writerGate(process.env);
  const rpcUrl = process.env["ENSV2_RPC_URL"] ?? "https://ethereum-sepolia-rpc.publicnode.com";

  // Deterministic dry-run identity (the real guardAccount when wiring live).
  const owner = gate.allowed
    ? privateKeyToAccount(process.env["ENSETH_PRIVATE_KEY"] as `0x${string}`).address
    : ("0xB30553e2f132126B951D3a6AD4E07EbAa5523b6E" as const);
  const secret = `0x${"cd".repeat(32)}` as `0x${string}`;

  const plan = buildRegistrationPlan({
    label,
    owner,
    secret,
    resume: RESUME,
    chainHead: CHAIN_HEAD,
  });

  console.log(`
━━━ BULWARK · ENSv2 record writer ━━━
  name:      ${plan.name}        (label "${label}")
  owner:     ${owner}
  registrar: ${ENSV2_ADDRESSES.ethRegistrar}
  resolver:  PermissionedResolver proxy via VerifiableFactory
             ${ENSV2_ADDRESSES.verifiableFactory}
             (impl ${ENSV2_ADDRESSES.permissionedResolverImpl})

  THE RÉSUMÉ (what lands under com.bulwark.resume):
${renderResume(RESUME)
  .split("\n")
  .map((l) => "    " + l)
  .join("\n")}
`);

  if (!gate.allowed) {
    console.log(`  ⚠  DRY RUN — no transactions will be sent.
     Set both ENSETH_PRIVATE_KEY and ENSV2_RPC_URL to execute.
     Missing: ${gate.missing.join(", ")}
`);
    printPlan(plan);
    printPreflightNote();
    return;
  }

  // Gated execution path — network reads first, writes only after preflight.
  const client = createEnsv2PublicClient(rpcUrl);
  const pre = await preflight(client, { label, wallet: owner });
  console.log(`  preflight: available=${pre.available} price=${pre.total} (6dp MockUSDC) balance=${pre.balance}`);
  if (!pre.available) {
    console.error(`  ✗ label "${label}" is not available — aborting before any write.`);
    process.exit(1);
  }
  if (pre.balance < pre.total) {
    console.error(`  ✗ insufficient MockUSDC (${pre.balance} < ${pre.total}) — aborting before any write.`);
    process.exit(1);
  }

  const account = privateKeyToAccount(process.env["ENSETH_PRIVATE_KEY"] as `0x${string}`);
  const wallet = createWalletClient({ account, transport: http(rpcUrl), chain: sepolia });
  printPlan(plan);
  console.log("\n  ✓ gate open — executing (deployProxy → approve → commit → 60s → register)…");
  const result = await executeRegistrationPlan(wallet, client, plan);
  console.log(`
  ✓ REGISTERED
    name:     ${plan.name}
    resolver: ${result.resolver}
    tokenId:  ${result.tokenId}
    txs:      ${result.txHashes.join("\n             ")}
`);
}

function printPlan(plan: ReturnType<typeof buildRegistrationPlan>): void {
  console.log(`  TX PLAN (in order):
    1. deployProxy  → ${plan.resolverDeploy.to}
       salt:  ${plan.resolverDeploy.salt}
       data:  ${plan.resolverDeploy.data.slice(0, 74)}…
       (init setters bake ${Object.keys(plan.textRecords).length} text records — same tx)
    2. approve      → ${plan.approve.to}
       spender: ${plan.approve.spender}
       amount:  <base+premium from getRegisterPrice> (MockUSDC, 6dp)
    3. commit       → ${plan.commit.to}
       commitment: ${plan.commit.commitment}
       data:  ${plan.commit.data.slice(0, 74)}…
       …wait ${plan.waitSeconds}s (MIN_COMMITMENT_AGE)…
    4. register     → ${plan.register.to}
       data:  ${plan.register.data.slice(0, 74)}…

  TEXT RECORDS (in the resolver proxy init, then on-chain readable):
${Object.entries(plan.textRecords)
  .map(([k, v]) => `    ${k} = ${JSON.stringify(v).slice(0, 90)}${v.length > 90 ? "…" : ""}`)
  .join("\n")}
`);
}

function printPreflightNote(): void {
  console.log(`  Credential gaps before this can go live (research §1.7):
    - Sepolia ETH for gas (4 txs): Google Cloud / Alchemy faucet, ENS Discord #faucet
    - ~8 MockUSDC for 1yr of a 5+char label: MockUSDC ${ENSV2_ADDRESSES.mockUsdc}
      (mint path unverified — check the contract for a public mint(); else ENS Discord)
`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
