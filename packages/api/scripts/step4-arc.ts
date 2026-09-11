/**
 * BULWARK Step 4 — the full two-gasp demo on Arc testnet, COLLECTED.
 *
 * One process, ONE SHOT (the fresh stack's daily budget + hold #1 are
 * consumed here — never re-run against the same stack):
 *
 *  0. read-only gate: guard dailyState must be pristine (spent 0, count 0,
 *     nextHoldId 1) and >25min must remain before the UTC-day rollover.
 *  1. planFor dry check: a synthetic VerdictAccepted trigger must produce
 *     the 3-post plan (calldata printed, NOTHING sent).
 *  2. ops registers a FRESH ERC-8004 agent; amara's EOA is bound as the
 *     agent wallet (EIP-712 AgentWalletSet, signed by the wallet key;
 *     failure is non-fatal — ops ownership authorizes validationRequest).
 *  3. live watcher on the fresh VerdictContract catches VerdictAccepted /
 *     HoldVerdictRouted. VerdictAccepted → orchestrator.handle(trigger,
 *     log.transactionHash) → validationRequest (ops) + validationResponse
 *     (watcher) + giveFeedback (reputation). HoldVerdictRouted clean=false
 *     → fail closed, nothing posted (by design); clean=true → feedback.
 *  4. the demo runs as a subprocess (cwd = REPO ROOT so bun auto-loads
 *     .env; env passthrough + DEMO_RPC_URL/DEMO_CHAIN_ID), stdout streams
 *     through, exit code captured.
 *  5. post-exit settle: eth_getLogs sweep from the pre-spawn block — the
 *     authoritative net for anything the live watcher missed — then
 *     readback of every contract the choreography touched.
 *  6. .wsl/step4-receipt.json + stdout summary. Every tx hash gets an
 *     arcscan URL (https://testnet.arcscan.app/tx/<hash>).
 *
 * Run (repo root): bun run packages/api/scripts/step4-arc.ts [--dry]
 *   --dry : gate + plan check only. NEVER sends a transaction.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEventLogs,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ARC_TESTNET_CHAIN_ID,
  IDENTITY_ABI,
  REPUTATION_ABI,
  SCORE_BY_OUTCOME,
  VALIDATION_ABI,
  VALUE_BY_OUTCOME,
  deriveRequestHash,
  erc8004ForChain,
} from "@bulwark/agent-sdk";

import {
  createOrchestrator,
  HOLD_VERDICT_ROUTED_EVENT,
  VERDICT_ACCEPTED_EVENT,
  type Erc8004Orchestrator,
  type VerdictTrigger,
} from "../src/erc8004-orchestrator.ts";
import { loadDeployment } from "../src/deployment.ts";
// Demo constants — single source of truth (importing protocol.ts is
// side-effect free: keys resolve lazily, DEMO_CHAIN_ID reads env only).
import { ALICE, BOB, FRESH_WALLET } from "../../demo/src/protocol.ts";

import GUARD_ARTIFACT from "../../../contracts/out/GuardAccount.sol/GuardAccount.json";
import VERDICTS_ARTIFACT from "../../../contracts/out/VerdictContract.sol/VerdictContract.json";
import MUTUAL_POOL_ARTIFACT from "../../../contracts/out/MutualPool.sol/MutualPool.json";

// ------------------------------------------------------------------ //
//                              Config                                //
// ------------------------------------------------------------------ //

const DRY = process.argv.includes("--dry");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io";
const CHAIN_ID = ARC_TESTNET_CHAIN_ID; // 5042002 — the fresh stack
const EXPLORER = "https://testnet.arcscan.app";
const ROLLOVER_MARGIN_SEC = 25 * 60; // hard deadline from preflight
const SETTLE_TIMEOUT_MS = 90_000;

const OPS_PK = process.env.ARC_OPS_KEY ?? process.env.ARC_SMOKE_OPS_KEY;
const WATCHER_PK = process.env.ARC_WATCHER_KEY ?? process.env.ARC_SMOKE_WATCHER_KEY;
const REP_PK = process.env.ARC_REPUTATION_KEY ?? process.env.ARC_SMOKE_REPUTATION_KEY;
const AMARA_PK = process.env.AMARA_PRIVATE_KEY;
if (!OPS_PK || !WATCHER_PK || !REP_PK || !AMARA_PK) {
  console.error(
    "missing env: need ARC_OPS_KEY (or ARC_SMOKE_OPS_KEY), ARC_WATCHER_KEY " +
      "(or ARC_SMOKE_WATCHER_KEY), ARC_REPUTATION_KEY (or ARC_SMOKE_REPUTATION_KEY), AMARA_PRIVATE_KEY",
  );
  process.exit(2);
}

const ops = privateKeyToAccount(OPS_PK as Hex);
const orchWatcher = privateKeyToAccount(WATCHER_PK as Hex);
const rep = privateKeyToAccount(REP_PK as Hex);
const amara = privateKeyToAccount(AMARA_PK as Hex);

/** demo.ts's look-alike (edit distance 1 from ALICE) — same derivation. */
const LOOKALIKE = `${ALICE.slice(0, -1)}${ALICE.endsWith("1") ? "2" : "1"}` as Address;

const client = createPublicClient({ transport: http(RPC) });

const dep = await loadDeployment(CHAIN_ID);
const guard = dep.contracts.guardAccount as Address;
const verdicts = dep.contracts.verdicts as Address;
const usdc = dep.contracts.usdc as Address;
const pool = dep.contracts.mutualPool as Address;
const registries = erc8004ForChain(CHAIN_ID);

const GUARD_ABI = GUARD_ARTIFACT.abi as unknown as Abi;
const VERDICTS_ABI = VERDICTS_ARTIFACT.abi as unknown as Abi;
const POOL_ABI = MUTUAL_POOL_ARTIFACT.abi as unknown as Abi;
const ERC20_BALANCE = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const arcscan = (h: string) => `${EXPLORER}/tx/${h}`; // receipt URL for every tx hash (3+ call sites, lockstep format)
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// bigint-safe JSON (args, readbacks, receipt)
const jsonSafe = (v: unknown): unknown => {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
};

// ------------------------------------------------------------------ //
//                        Receipt (built as we go)                    //
// ------------------------------------------------------------------ //

interface StepEntry { label: string; txHash: string; status: string; contract: string; arcscanUrl: string }
interface PostEntry { kind: string; txHash: string; status: string; arcscanUrl: string }

const receipt = {
  chainId: CHAIN_ID,
  rpc: RPC,
  explorer: EXPLORER,
  stackAddresses: dep.contracts,
  agentId: null as string | null,
  registries,
  steps: [] as StepEntry[],
  eventsCaught: [] as { name: string; txHash: string; args: unknown }[],
  registryPosts: [] as PostEntry[],
  readback: {} as Record<string, unknown>,
  demoExitCode: null as number | null,
  utcStart: new Date().toISOString(),
  utcEnd: null as string | null,
  error: null as string | null,
};

// ------------------------------------------------------------------ //
//                            Chain helpers                           //
// ------------------------------------------------------------------ //

async function sendAndWait(
  label: string,
  account: PrivateKeyAccount,
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<{ hash: `0x${string}`; status: string; logs: readonly unknown[] }> {
  const data = encodeFunctionData({ abi, functionName, args: args as never });
  const wallet = createWalletClient({ account, transport: http(RPC) });
  const hash = await wallet.sendTransaction({ account, to, data, chain: null } as never);
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${label} reverted on-chain (${hash})`);
  console.log(`  ${label}: ${hash}`);
  return { hash, status: r.status, logs: r.logs as unknown as readonly unknown[] };
}

async function guardDaily(): Promise<{ day: bigint; spent: bigint; count: bigint; nextHoldId: bigint }> {
  const [day, spent, count] = (await client.readContract({
    address: guard, abi: GUARD_ABI, functionName: "dailyState",
  })) as [bigint, bigint, bigint];
  const nextHoldId = (await client.readContract({
    address: guard, abi: GUARD_ABI, functionName: "nextHoldId",
  })) as bigint;
  return { day, spent, count, nextHoldId };
}

/** USDC balance read (7 call sites — one-liner kept for the lockstep read shape). */
async function usdcBal(who: Address): Promise<bigint> {
  return client.readContract({ address: usdc, abi: ERC20_BALANCE, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
}

// ------------------------------------------------------------------ //
//                    Phase 0/1: gate + plan dry check                //
// ------------------------------------------------------------------ //

function planCheck(orch: Erc8004Orchestrator, agentId: bigint) {
  const digest = keccak256(toHex(`step4-plan-check:${Date.now()}`));
  const txHash = keccak256(toHex(`step4-plan-check-tx:${Date.now()}`));
  const trigger: VerdictTrigger = { kind: "VerdictAccepted", digest, guardAccount: guard, outcomeByte: 1, txHash };
  const plan = orch.planFor(trigger, txHash);
  const expectedRequestHash = deriveRequestHash({
    agentId, guardAccount: guard, txHash, digest, chainId: CHAIN_ID,
  });
  const steps = [
    ["validationRequest", plan.validationRequest],
    ["validationResponse", plan.validationResponse],
    ["giveFeedback", plan.feedback],
  ] as const;
  console.log("  planFor(synthetic VerdictAccepted, txHash):");
  for (const [name, step] of steps) {
    if (!step) continue;
    console.log(`    ${name.padEnd(19)} from=${step.from} to=${step.to} selector=${step.data.slice(0, 10)}`);
  }
  const ok = steps.every(([, step]) => !!step);
  const requestHashOk = plan.requestHash === expectedRequestHash;
  console.log(`  plan ok=${ok} requestHashFormulaOk=${requestHashOk} requestHash=${plan.requestHash}`);
  return { ok: ok && requestHashOk, plan };
}

// The gate: fresh stack must be untouched, and the UTC day must not roll
// mid-run (a midnight crossing resets the guard's daily counters).
const st0 = await guardDaily();
const nowSec = Math.floor(Date.now() / 1000);
const rolloverEpoch = (Number(st0.day) + 1) * 86_400;
const secToRollover = rolloverEpoch - nowSec;
console.log(`step4 collector — chain ${CHAIN_ID} · ${RPC}`);
console.log(`  guard dailyState: day=${st0.day} spent=${st0.spent} count=${st0.count} nextHoldId=${st0.nextHoldId}`);
console.log(`  sec to UTC-day rollover: ${secToRollover}`);

const pristine = st0.spent === 0n && st0.count === 0n && st0.nextHoldId === 1n;
if (!pristine) {
  receipt.error = `STACK ALREADY CONSUMED: dailyState(day=${st0.day}, spent=${st0.spent}, count=${st0.count}), nextHoldId=${st0.nextHoldId} — refusing to broadcast`;
  console.error(`\nABORT: ${receipt.error}`);
  if (!DRY) { receipt.utcEnd = new Date().toISOString(); writeReceipt(); }
  process.exit(1);
}
if (secToRollover < ROLLOVER_MARGIN_SEC) {
  receipt.error = `UTC-day rollover in ${secToRollover}s (< ${ROLLOVER_MARGIN_SEC}s margin) — refusing to broadcast`;
  console.error(`\nABORT: ${receipt.error}`);
  if (!DRY) { receipt.utcEnd = new Date().toISOString(); writeReceipt(); }
  process.exit(1);
}

// Dry plan check with a throwaway orchestrator (planFor sends nothing).
{
  const dryOrch = createOrchestrator({
    opsKey: ops, watcherKey: orchWatcher, reputationKey: rep,
    agentId: 1n, chainId: CHAIN_ID, rpcUrl: RPC,
  });
  const { ok } = planCheck(dryOrch, 1n);
  if (!ok) {
    console.error("ABORT: planFor did not produce the expected 3-post plan / requestHash formula mismatch");
    process.exit(1);
  }
}

if (DRY) {
  console.log("\nDRY OK — gate passed, 3-post plan verified. No transaction sent.");
  process.exit(0);
}

// ------------------------------------------------------------------ //
//                  Phase 2: register + bind (ops writes)             //
// ------------------------------------------------------------------ //

console.log("\n=== ERC-8004 agent registration (ops) ===");
const agentUri = `bulwark://agents/atlas-arc-${Date.now()}.json`;
const reg = await sendAndWait("register", ops, registries.identity as Address, IDENTITY_ABI, "register", [agentUri]);
const regReceipt = await client.waitForTransactionReceipt({ hash: reg.hash, timeout: 180_000 });
const agentId = BigInt((regReceipt.logs[0] as { topics: readonly `0x${string}`[] }).topics[3]!);
receipt.agentId = agentId.toString();
receipt.steps.push({ label: "erc8004-register-agent", txHash: reg.hash, status: reg.status, contract: registries.identity, arcscanUrl: arcscan(reg.hash) });
console.log(`  agentId ${agentId} (${agentUri})`);

// Bind the agent wallet to amara's EOA (guard owner). Signature comes from
// the WALLET key (amara); ops submits. Non-fatal on failure.
let bindError: string | null = null;
try {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
  const domain = {
    name: "ERC8004IdentityRegistry", version: "1", chainId: CHAIN_ID,
    verifyingContract: registries.identity as `0x${string}`,
  };
  const types = {
    AgentWalletSet: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "owner", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const message = { agentId, newWallet: amara.address, owner: ops.address, deadline };
  const signature = await amara.signTypedData({ domain, types, primaryType: "AgentWalletSet", message } as never);
  const bind = await sendAndWait("setAgentWallet", ops, registries.identity as Address, IDENTITY_ABI, "setAgentWallet", [
    agentId, amara.address, deadline, signature,
  ]);
  receipt.steps.push({ label: "erc8004-bind-agent-wallet", txHash: bind.hash, status: bind.status, contract: registries.identity, arcscanUrl: arcscan(bind.hash) });
} catch (e) {
  bindError = e instanceof Error ? e.message : String(e);
  console.log(`  setAgentWallet failed (non-fatal, continuing): ${bindError}`);
  receipt.readback.bindError = bindError;
}

// ------------------------------------------------------------------ //
//            Phase 3: live orchestrator + event watcher              //
// ------------------------------------------------------------------ //

const orch = createOrchestrator({
  opsKey: ops, watcherKey: orchWatcher, reputationKey: rep,
  agentId, chainId: CHAIN_ID, rpcUrl: RPC,
});
const seen = new Set<string>(); // `${txHash}:${logIndex}` — event dedupe (dynamic membership)
const postedDigests = new Set<string>(); // mirror-level digest dedupe (dynamic membership)
const pendingPosts: { kind: string; txHash: `0x${string}` }[] = [];
const mirrorErrors: string[] = [];
let acceptedSeen = false;
let holdRoutedSeen = false;
let covered: { trigger: VerdictTrigger; txHash: `0x${string}` } | undefined;

// All event processing (live watcher AND sweep) is serialized through this
// queue so registry posts never race each other.
let queue: Promise<void> = Promise.resolve();
const enqueue = (fn: () => Promise<void>) => {
  queue = queue.then(fn).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    mirrorErrors.push(msg);
    console.error(`  [queue] event processing failed: ${msg}`);
  });
};

/** Mirror one parsed VerdictContract event into the registries. */
async function mirror(log: { topics: readonly `0x${string}`[]; data: `0x${string}`; transactionHash: `0x${string}` }): Promise<void> {
  const triggers = orch.parseTriggers([{ topics: log.topics, data: log.data.length > 2 ? log.data : "0x" }]);
  for (const t of triggers) {
    if (postedDigests.has(t.digest)) continue;
    postedDigests.add(t.digest);
    try {
      // VerdictAccepted: pass the event's real txHash → 3-post plan.
      // HoldVerdictRouted (clean=true): NO txHash → feedback only.
      const sent = t.kind === "VerdictAccepted" ? await orch.handle(t, log.transactionHash) : await orch.handle(t);
      const kinds = ["validationRequest", "validationResponse", "giveFeedback"];
      for (let i = 0; i < sent.length; i++) pendingPosts.push({ kind: kinds[i]!, txHash: sent[i]! });
      if (t.kind === "VerdictAccepted") covered = { trigger: t, txHash: log.transactionHash };
      console.log(`  [mirror] ${t.kind} ${t.digest.slice(0, 18)}… → ${sent.length} registry post(s)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mirrorErrors.push(`${t.kind}: ${msg}`);
      console.error(`  [mirror] ${t.kind} failed: ${msg}`);
    }
  }
}

/** Record + (for verdicts) mirror one parsed event. Idempotent via `seen`. */
async function processEvent(e: { eventName: string; args?: unknown; transactionHash: `0x${string}`; logIndex: number; topics: readonly `0x${string}`[]; data: `0x${string}` }, source: "live" | "guard" | "verdicts"): Promise<void> {
  const key = `${e.transactionHash}:${e.logIndex}`;
  if (seen.has(key)) return;
  seen.add(key);
  receipt.eventsCaught.push({ name: e.eventName, txHash: e.transactionHash, args: jsonSafe(e.args) });
  console.log(`  [${source}] ${e.eventName} @ ${e.transactionHash}`);
  if (source === "guard" || source === "verdicts") {
    if (e.eventName === "VerdictAccepted") acceptedSeen = true;
    if (e.eventName === "HoldVerdictRouted") holdRoutedSeen = true;
  }
  if (source === "verdicts" || source === "live") await mirror(e);
}

const unwatch = client.watchContractEvent({
  address: verdicts,
  abi: [VERDICT_ACCEPTED_EVENT, HOLD_VERDICT_ROUTED_EVENT] as never,
  onLogs: (logs: readonly unknown[]) => {
    for (const log of logs as { eventName: string; args?: unknown; transactionHash: `0x${string}`; logIndex: number; topics: readonly `0x${string}`[]; data: `0x${string}` }[]) {
      enqueue(() => processEvent(log, "live"));
    }
  },
  onError: (err: Error) => console.error(`  [live] subscription error: ${err.message}`),
});

// ------------------------------------------------------------------ //
//                     Phase 4: run the demo (ONCE)                   //
// ------------------------------------------------------------------ //

const amaraBefore = await usdcBal(amara.address);
const startBlock = await client.getBlockNumber();
console.log(`\n=== demo spawn (cwd repo root, from block ${startBlock}) — amara USDC before: ${amaraBefore} ===`);
const proc = Bun.spawn(["bun", "run", "packages/demo/src/demo.ts"], {
  cwd: repoRoot,
  env: { ...process.env, DEMO_RPC_URL: RPC, DEMO_CHAIN_ID: String(CHAIN_ID) },
  stdout: "inherit",
  stderr: "inherit",
});
const demoExitCode = await proc.exited;
receipt.demoExitCode = demoExitCode;
console.log(`\n=== demo exited with code ${demoExitCode} ===`);

// ------------------------------------------------------------------ //
//         Phase 5: settle + authoritative getLogs sweep              //
// ------------------------------------------------------------------ //

async function sweepOnce(): Promise<void> {
  const [gLogs, vLogs] = await Promise.all([
    client.getLogs({ address: guard, fromBlock: startBlock, toBlock: "latest" }),
    client.getLogs({ address: verdicts, fromBlock: startBlock, toBlock: "latest" }),
  ]);
  const gParsed = parseEventLogs({ abi: GUARD_ABI, logs: gLogs as never }) as unknown as { eventName: string; args?: unknown; transactionHash: `0x${string}`; logIndex: number; blockNumber: bigint; topics: readonly `0x${string}`[]; data: `0x${string}` }[];
  const vParsed = parseEventLogs({ abi: VERDICTS_ABI, logs: vLogs as never }) as unknown as { eventName: string; args?: unknown; transactionHash: `0x${string}`; logIndex: number; blockNumber: bigint; topics: readonly `0x${string}`[]; data: `0x${string}` }[];
  // Static literal membership — Record, not Set.
  const INTERESTING: Record<string, true> = {
    ExecutedRoutine: true, Held: true, OwnerDecision: true, AttemptedBreach: true, // guard
    HoldVerdictRouted: true, VerdictAccepted: true, AttemptedBreachSignal: true, StrikeRecorded: true, // verdicts
  };
  const all = [
    ...gParsed.map((e) => ({ e, src: "guard" as const })),
    ...vParsed.map((e) => ({ e, src: "verdicts" as const })),
  ]
    .filter(({ e }) => INTERESTING[e.eventName])
    .sort((a, b) => (a.e.blockNumber === b.e.blockNumber ? a.e.logIndex - b.e.logIndex : a.e.blockNumber < b.e.blockNumber ? -1 : 1));
  for (const { e, src } of all) enqueue(() => processEvent(e, src));
}

const settleDeadline = Date.now() + (demoExitCode === 0 ? SETTLE_TIMEOUT_MS : 15_000);
while (Date.now() < settleDeadline) {
  await sweepOnce();
  await queue;
  if (acceptedSeen && holdRoutedSeen) break;
  if (demoExitCode !== 0) break; // demo failed — record what exists, stop waiting
  await sleep(3_000);
}
await queue; // all mirroring done
unwatch();

// Registry post receipts.
for (const p of pendingPosts) {
  try {
    const r = await client.waitForTransactionReceipt({ hash: p.txHash, timeout: 180_000 });
    receipt.registryPosts.push({ kind: p.kind, txHash: p.txHash, status: r.status, arcscanUrl: arcscan(p.txHash) });
    console.log(`  registryPost ${p.kind}: ${p.txHash} (${r.status})`);
  } catch (e) {
    receipt.registryPosts.push({ kind: p.kind, txHash: p.txHash, status: "unknown", arcscanUrl: arcscan(p.txHash) });
    console.error(`  registryPost ${p.kind}: receipt error ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Demo steps from the caught events (ordered by block/logIndex already).
{
  let aliceN = 0, bobN = 0;
  // VerdictContract emits these; everything else caught is GuardAccount.
  const VERDICT_EVENTS: Record<string, true> = {
    HoldVerdictRouted: true, VerdictAccepted: true, AttemptedBreachSignal: true, StrikeRecorded: true,
  };
  for (const e of receipt.eventsCaught) {
    const to = (e.args as { to?: string } | undefined)?.to?.toLowerCase();
    let label: string | null = null;
    switch (e.name) {
      case "ExecutedRoutine":
        label = to === ALICE.toLowerCase() ? `payroll-${2 * ++aliceN - 1}` : to === BOB.toLowerCase() ? `payroll-${2 * ++bobN}` : "gasp2-slip-payment";
        break;
      case "Held": label = "gasp1-hold-payment-held"; break;
      case "OwnerDecision": label = "gasp1-owner-freeze-decision"; break;
      case "HoldVerdictRouted": label = "gasp1-hold-verdict-suspicious"; break;
      case "VerdictAccepted": label = "gasp2-covered-verdict"; break;
      case "AttemptedBreach": label = "gasp1-attempted-breach"; break;
      case "AttemptedBreachSignal": label = "gasp1-attempted-breach-signal"; break;
      case "StrikeRecorded": label = "blocklist-strike-recorded"; break;
    }
    if (!label) continue;
    const r = await client.waitForTransactionReceipt({ hash: e.txHash as `0x${string}`, timeout: 180_000 });
    receipt.steps.push({ label, txHash: e.txHash, status: r.status, contract: VERDICT_EVENTS[e.name] ? verdicts : guard, arcscanUrl: arcscan(e.txHash) });
  }
}

// ------------------------------------------------------------------ //
//                        Phase 6: readback                           //
// ------------------------------------------------------------------ //

const st1 = await guardDaily();
const [guardUsdc, amaraAfter, junior, senior, freshBal, lookalikeBal, agentOwner] = await Promise.all([
  usdcBal(guard),
  usdcBal(amara.address),
  client.readContract({ address: pool, abi: POOL_ABI, functionName: "juniorCapital" }) as Promise<bigint>,
  client.readContract({ address: pool, abi: POOL_ABI, functionName: "seniorCapital" }) as Promise<bigint>,
  usdcBal(FRESH_WALLET as Address),
  usdcBal(LOOKALIKE),
  client.readContract({ address: registries.identity as Address, abi: IDENTITY_ABI, functionName: "ownerOf", args: [agentId] }) as Promise<Address>,
]);

// Registry readbacks — the requestHash the orchestrator bound the covered
// verdict to (same formula: agentId, guardAccount, txHash, digest, chainId).
let validation: Record<string, unknown> | undefined;
if (covered) {
  const requestHash = deriveRequestHash({
    agentId,
    guardAccount: covered.trigger.guardAccount,
    txHash: covered.txHash,
    digest: covered.trigger.digest,
    chainId: CHAIN_ID,
  });
  try {
    const s = (await client.readContract({
      address: registries.validation as Address, abi: VALIDATION_ABI,
      functionName: "getValidationStatus", args: [requestHash],
    })) as [Address, bigint, number, `0x${string}`, string, bigint];
    validation = { requestHash, validatorAddress: s[0], agentId: s[1].toString(), response: s[2], responseHash: s[3], tag: s[4], lastUpdate: s[5].toString() };
  } catch (e) {
    validation = { requestHash, found: false, error: e instanceof Error ? e.message : String(e) };
  }
}

let feedback: Record<string, unknown> | undefined;
try {
  const f = (await client.readContract({
    address: registries.reputation as Address, abi: REPUTATION_ABI,
    functionName: "readFeedback", args: [agentId, rep.address, 1n], // 1-based index
  })) as [bigint, number, string, string, boolean];
  feedback = { value: f[0].toString(), valueDecimals: f[1], tag1: f[2], tag2: f[3], isRevoked: f[4], expectedValue: VALUE_BY_OUTCOME.COVERED.toString() };
} catch (e) {
  feedback = { error: e instanceof Error ? e.message : String(e) };
}

const amaraDelta = amaraAfter - amaraBefore;
const checks = {
  demoExitZero: demoExitCode === 0,
  amaraPayoutOk: amaraDelta === 135_000_000n,
  nextHoldIdAdvanced: st1.nextHoldId > st0.nextHoldId,
  freshWalletZero: freshBal === 0n,
  lookalikePaid: lookalikeBal === 150_000_000n,
  validationCovered: validation?.response === SCORE_BY_OUTCOME.COVERED,
  feedbackCovered: feedback?.value === VALUE_BY_OUTCOME.COVERED.toString(),
  registryPostsCount: receipt.registryPosts.length === 3 && receipt.registryPosts.every((p) => p.status === "success"),
};
if (mirrorErrors.length > 0) (receipt as { mirrorErrors?: string[] }).mirrorErrors = mirrorErrors;

receipt.readback = {
  dailyState: { day: st1.day.toString(), spent: st1.spent.toString(), count: st1.count.toString() },
  nextHoldId: st1.nextHoldId.toString(),
  guardUsdc: guardUsdc.toString(),
  amaraUsdcBefore: amaraBefore.toString(),
  amaraUsdcAfter: amaraAfter.toString(),
  amaraUsdcDelta: amaraDelta.toString(),
  poolJunior: junior.toString(),
  poolSenior: senior.toString(),
  freshWalletUsdc: freshBal.toString(),
  lookalikeUsdc: lookalikeBal.toString(),
  agentNftOwner: agentOwner,
  validation,
  feedback,
  checks,
};

receipt.utcEnd = new Date().toISOString();
writeReceipt();

// ------------------------------------------------------------------ //
//                          Summary + exit                            //
// ------------------------------------------------------------------ //

const passCount = Object.values(checks).filter(Boolean).length;
const totalChecks = Object.keys(checks).length;
console.log("\n==== STEP 4 SUMMARY ====");
console.log(`  agentId        : ${agentId}`);
for (const s of receipt.steps) console.log(`  ${s.label.padEnd(32)} ${s.status === "success" ? "✓" : "✗"} ${s.txHash}`);
for (const p of receipt.registryPosts) console.log(`  registry:${p.kind.padEnd(22)} ${p.status === "success" ? "✓" : "✗"} ${p.txHash}`);
console.log(`  demo exit      : ${demoExitCode}`);
console.log(`  amara payout   : ${amaraDelta} (expected 135000000)`);
console.log(`  nextHoldId     : ${st0.nextHoldId} → ${st1.nextHoldId}`);
console.log(`  validation     : response=${validation?.response} tag=${validation?.tag}`);
console.log(`  feedback       : value=${feedback?.value} tag1=${feedback?.tag1} tag2=${feedback?.tag2}`);
console.log(`  checks         : ${passCount}/${totalChecks} ${passCount === totalChecks ? "PASS" : "FAIL"}`);
if (mirrorErrors.length > 0) console.log(`  mirror errors  : ${mirrorErrors.length}`);
console.log(`  receipt        : ${resolve(repoRoot, ".wsl/step4-receipt.json")}`);
console.log("\n==== FULL RECEIPT ====");
console.log(JSON.stringify(receipt, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

process.exit(passCount === totalChecks && demoExitCode === 0 ? 0 : 1);

// ------------------------------------------------------------------ //
//                             Utilities                              //
// ------------------------------------------------------------------ //

function writeReceipt(): void {
  const out = resolve(repoRoot, ".wsl/step4-receipt.json");
  writeFileSync(out, JSON.stringify(receipt, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`receipt written: ${out}`);
}
