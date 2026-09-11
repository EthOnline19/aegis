/**
 * REPAYD Coverage API — Bun-native HTTP server.
 *
 * POST   /v1/coverage          create a policy (platforms call at agent birth)
 * GET    /v1/coverage/:id      fetch a policy
 * GET    /v1/platforms/:name   fleet dashboard (agents, volume, rev-share)
 * DELETE /v1/coverage/:id      cancel
 * POST   /v1/webhooks/platform event stream: agent created / funded / dormant
 * GET    /v1/atlas/overview    live REPAYD agent state (Arc testnet, read-only)
 * GET    /v1/circle/agent-wallet  Circle Agent Stack touchpoint (dry-run default)
 */

import { createPublicClient, http, parseAbi } from "viem";

import { agentWalletState, circleFromEnv } from "./circle/agent-wallet.ts";
import { loadDeployment } from "./deployment.ts";

import { CoverageStore } from "./store.ts";
import { attachOnChain, bridgeFromEnv, verifyGuardOwnership } from "./coverage-bridge.ts";
import { parseCoverageRequest } from "./schemas.ts";
import type { StoredPolicy } from "./store.ts";

const store = new CoverageStore();

const PORT = Number(process.env.REPAYD_API_PORT ?? 8787);

/** JSON response; bigint values serialize as strings. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const now = Math.floor(Date.now() / 1000);

    // ------------------ GET /v1/atlas/overview ------------------ //
    if (req.method === "GET" && path === "/v1/atlas/overview") {
      try {
        const dep = await loadDeployment(5042002);
        const rpc = process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.io";
        const client = createPublicClient({ transport: http(rpc) });
        const ABI = parseAbi([
          "function dailyState() view returns (uint256 day, uint96 spent, uint256 count)",
          "function nextHoldId() view returns (uint256)",
          "function balanceOf(address) view returns (uint256)",
          "function juniorCapital() view returns (uint96)",
          "function seniorCapital() view returns (uint96)",
        ]);
        const guard = dep.contracts.guardAccount;
        const [daily, holdId, guardUsdc, junior, senior] = await Promise.all([
          client.readContract({ address: guard, abi: ABI, functionName: "dailyState" }) as Promise<[bigint, bigint, bigint]>,
          client.readContract({ address: guard, abi: ABI, functionName: "nextHoldId" }) as Promise<bigint>,
          client.readContract({ address: dep.contracts.usdc, abi: ABI, functionName: "balanceOf", args: [guard] }) as Promise<bigint>,
          client.readContract({ address: dep.contracts.mutualPool, abi: ABI, functionName: "juniorCapital" }) as Promise<bigint>,
          client.readContract({ address: dep.contracts.mutualPool, abi: ABI, functionName: "seniorCapital" }) as Promise<bigint>,
        ]);
        const amaraUsdc = (await client.readContract({
          address: dep.contracts.usdc,
          abi: ABI,
          functionName: "balanceOf",
          args: [dep.actors.amaraPolicyOwner],
        })) as bigint;
        return json(200, {
          chainId: dep.chainId,
          agent: { erc8004AgentId: 894341, guard, owner: dep.actors.amaraPolicyOwner },
          guard: {
            usdc: guardUsdc.toString(),
            dailyState: { day: daily[0].toString(), spent: daily[1].toString(), count: daily[2].toString() },
            nextHoldId: holdId.toString(),
          },
          pool: { junior: junior.toString(), senior: senior.toString() },
          payout: { amaraUsdc: amaraUsdc.toString() },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "rpc error";
        return json(502, { error: message });
      }
    }

    // ------------------ GET /v1/circle/agent-wallet ------------------ //
    if (req.method === "GET" && path === "/v1/circle/agent-wallet") {
      try {
        const dep = await loadDeployment(5042002);
        const client = createPublicClient({
          transport: http(process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.io"),
        });
        const ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
        const guardUsdc = (await client.readContract({
          address: dep.contracts.usdc,
          abi: ABI,
          functionName: "balanceOf",
          args: [dep.contracts.guardAccount],
        })) as bigint;
        const config = circleFromEnv();
        const state = await agentWalletState(config, {
          address: dep.contracts.guardAccount,
          usdcBalance: guardUsdc.toString(),
        });
        return json(200, state);
      } catch (e) {
        const message = e instanceof Error ? e.message : "circle error";
        return json(502, { error: message });
      }
    }

    // ------------------ POST /v1/coverage ------------------ //
    if (req.method === "POST" && path === "/v1/coverage") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      try {
        const parsed = parseCoverageRequest(body);
        const response = store.create(parsed, now);
        // On-chain materialization (§14 → §30): when the platform key is
        // configured, the policy is attached to PolicyRegistry so the
        // GuardAccount enforces it and the Risk Subgraph indexes the event.
        // Store-first keeps the API contract intact even if the chain leg
        // fails — the response carries the outcome.
        const bridge = bridgeFromEnv();
        if (bridge) {
          const ownership = await verifyGuardOwnership(bridge, parsed.agentWallet);
          if (!ownership.ok) {
            return json(422, { error: `guard precheck failed: ${ownership.reason}` });
          }
          const attach = await attachOnChain(bridge, parsed.policy, parsed.agentWallet);
          return json(201, { ...response, onChain: { txHash: attach.txHash, version: attach.version, policyHash: attach.policyHash, registry: attach.registry } });
        }
        return json(201, response);
      } catch (e) {
        const message = e instanceof Error ? e.message : "bad request";
        return json(400, { error: message });
      }
    }

    // ------------------ GET / DELETE /v1/coverage/:id ------------------ //
    const coverageMatch = path.match(/^\/v1\/coverage\/(bwk_[a-z0-9]+)$/);
    if (coverageMatch) {
      const policyId = coverageMatch[1] ?? "";
      if (req.method === "GET") {
        const policy = store.get(policyId);
        if (!policy) return json(404, { error: "policy not found" });
        return json(200, serializePolicy(policy));
      }
      if (req.method === "DELETE") {
        try {
          const cancelled = store.cancel(policyId, now);
          return json(200, serializePolicy(cancelled));
        } catch (e) {
          const message = e instanceof Error ? e.message : "error";
          return json(404, { error: message });
        }
      }
    }

    // ------------------ GET /v1/platforms/:name ------------------ //
    const platformMatch = path.match(/^\/v1\/platforms\/([a-z0-9-]+)$/);
    if (req.method === "GET" && platformMatch) {
      const name = platformMatch[1] ?? "";
      const stats = store.platformStats(name);
      const fleet = store.listByPlatform(name);
      if (!stats && fleet.length === 0) {
        return json(404, { error: "unknown platform" });
      }
      const volume = stats?.premiumVolume ?? 0n;
      const revShareBps = stats?.revShareBps ?? 0;
      return json(200, {
        platform: name,
        agents: fleet.length,
        premiumVolume: volume,
        revShareBps,
        revShareMonthly: (volume * BigInt(revShareBps)) / 10_000n,
      });
    }

    // ------------------ POST /v1/webhooks/platform ------------------ //
    if (req.method === "POST" && path === "/v1/webhooks/platform") {
      // Event stream sink (agent created / funded / dormant). v1: accepted
      // and acknowledged; the pricing engine consumes these via the subgraph.
      return json(200, { received: true });
    }

    return json(404, { error: "not found" });
  },
});

function serializePolicy(p: StoredPolicy): Record<string, unknown> {
  return {
    policyId: p.policyId,
    agent: p.request.agentWallet,
    platform: p.request.platform,
    status: p.status,
    cap: p.request.policy.cap,
    perTx: p.request.policy.perTx,
    multiplier: p.response.multiplier,
    monthlyPremium: p.response.monthlyPremium,
    premiumStream: p.response.premiumStream,
    record: p.response.record,
    createdAt: p.createdAt,
  };
}

console.log(`REPAYD Coverage API listening on :${server.port}`);
