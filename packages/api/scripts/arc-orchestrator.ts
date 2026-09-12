/**
 * Live-event orchestrator wiring (design §7 step 3).
 *
 * Subscribes to VerdictAccepted / HoldVerdictRouted from a deployed
 * VerdictContract (anvil demo deployment OR any testnet address via env),
 * parses the raw logs into triggers, and drives Erc8004Orchestrator.handle()
 * — the three-post mirror into the ERC-8004 registries.
 *
 * Modes:
 *  - ANVIL (default): attaches to the local anvil demo deployment; the
 *    orchestrator registers Atlas's agentId itself at startup (ops key),
 *    then mirrors every verdict event.
 *  - ARC: set ARC_VERDICT_ADDRESS + ARC_AGENT_ID + ARC_OPS_KEY /
 *    ARC_WATCHER_KEY / ARC_REPUTATION_KEY (funded with native USDC gas)
 *    to mirror live VerdictContract events on Arc testnet.
 *
 * Run: bun run packages/api/scripts/arc-orchestrator.ts
 */
import { createPublicClient, http, publicActions, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ARC_TESTNET_CHAIN_ID } from "@repayd/agent-sdk";
import {
  createOrchestrator,
  HOLD_VERDICT_ROUTED_EVENT,
  VERDICT_ACCEPTED_EVENT,
  type OrchestratorConfig,
} from "../src/erc8004-orchestrator.ts";
import { loadDeployment } from "../src/deployment.ts";

const RPC = process.env.ARC_RPC_URL ?? "http://localhost:8545";
const VERDICT_ADDRESS =
  (process.env.ARC_VERDICT_ADDRESS as `0x${string}` | undefined) ??
  // Fallback: read the address from the forge deployment record (no env needed
  // once Deploy.s.sol has run for this chain).
  (await loadDeployment(Number(process.env.ARC_TESTNET_CHAIN_ID) || undefined)
    .then((d) => d.contracts.verdicts)
    .catch(() => undefined));
const OPS_PK = process.env.ARC_OPS_KEY;
const WATCHER_PK = process.env.ARC_WATCHER_KEY;
const REPUTATION_PK = process.env.ARC_REPUTATION_KEY;
const AGENT_ID = process.env.ARC_AGENT_ID ? BigInt(process.env.ARC_AGENT_ID) : undefined;

if (!VERDICT_ADDRESS || !OPS_PK || !WATCHER_PK || !REPUTATION_PK || AGENT_ID === undefined) {
  const missing = [
    OPS_PK ? undefined : "ARC_OPS_KEY",
    WATCHER_PK ? undefined : "ARC_WATCHER_KEY",
    REPUTATION_PK ? undefined : "ARC_REPUTATION_KEY",
    AGENT_ID === undefined ? "ARC_AGENT_ID" : undefined,
    VERDICT_ADDRESS
      ? undefined
      : "ARC_VERDICT_ADDRESS (or run Deploy.s.sol — falls back to contracts/deployments/<chainId>.json)",
  ].filter(Boolean);
  console.error(`Missing ${missing.join(", ")} (each funded — native USDC on Arc) to mirror live events.`);
  process.exit(2);
}

const ops = privateKeyToAccount(OPS_PK as `0x${string}`);
const watcher = privateKeyToAccount(WATCHER_PK as `0x${string}`);
const reputation = privateKeyToAccount(REPUTATION_PK as `0x${string}`);

const orchestrator = createOrchestrator({
  opsKey: ops,
  watcherKey: watcher,
  reputationKey: reputation,
  agentId: AGENT_ID,
  chainId: ARC_TESTNET_CHAIN_ID,
  rpcUrl: RPC,
} satisfies OrchestratorConfig);

let syncing = false;
const watcherClient = createPublicClient({ transport: http(RPC) }).extend(publicActions);
const unwatch = watcherClient.watchContractEvent({
  address: VERDICT_ADDRESS,
  abi: [VERDICT_ACCEPTED_EVENT, HOLD_VERDICT_ROUTED_EVENT] as const,
  onLogs: async (logs: readonly Log[]) => {
    if (syncing) return; // collapse overlapping poll cycles
    syncing = true;
    try {
      const triggers = orchestrator.parseTriggers(
        logs.map((l) => {
          const data: `0x${string}` = typeof l.data === "string" && l.data.length > 2 ? (l.data as `0x${string}`) : "0x";
          return { topics: l.topics, data };
        }),
      );
      for (const t of triggers) {
        const sent = await orchestrator.handle(t).catch((err: unknown) => {
          console.error(`  handle(${t.kind} ${t.digest}) failed:`, (err as Error).message);
          return [] as readonly `0x${string}`[];
        });
        if (sent.length > 0) console.log(`  mirrored ${t.kind} ${t.digest}: ${sent.length} posts`);
      }
    } finally {
      syncing = false;
    }
  },
  onError: (err: Error) => console.error("event subscription error:", err.message),
});

console.log(`orchestrator live: verdicts ${VERDICT_ADDRESS} on ${RPC}`);
console.log(`  ops ${ops.address} / watcher ${watcher.address} / reputation ${reputation.address}`);
console.log(`  agentId ${AGENT_ID}`);
process.on("SIGINT", () => {
  unwatch();
  process.exit(0);
});
