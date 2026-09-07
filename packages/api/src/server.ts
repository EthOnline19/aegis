/**
 * BULWARK Coverage API — Bun-native HTTP server.
 *
 * POST   /v1/coverage          create a policy (platforms call at agent birth)
 * GET    /v1/coverage/:id      fetch a policy
 * GET    /v1/platforms/:name   fleet dashboard (agents, volume, rev-share)
 * DELETE /v1/coverage/:id      cancel
 * POST   /v1/webhooks/platform event stream: agent created / funded / dormant
 */

import { CoverageStore } from "./store.ts";
import { parseCoverageRequest } from "./schemas.ts";
import type { StoredPolicy } from "./store.ts";

const store = new CoverageStore();

const PORT = Number(process.env.BULWARK_API_PORT ?? 8787);

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

console.log(`BULWARK Coverage API listening on :${server.port}`);
