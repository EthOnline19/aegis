/**
 * Dashboard server — serves the three REPAYD surfaces and their JSON feeds.
 * The feeds proxy the Coverage API + demo protocol state; in production the
 * same shapes come from the Risk Subgraph.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.REPAYD_DASH_PORT ?? 3000);
const API = process.env.REPAYD_API_URL ?? "http://localhost:8787";

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname;

    // -------- Static surfaces. -------- //
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return html("owner");
    }
    if (req.method === "GET" && path === "/capital") {
      return html("capital");
    }
    if (req.method === "GET" && path === "/record") {
      return html("record");
    }

    // -------- JSON feeds (proxy the Coverage API where applicable). -------- //
    if (req.method === "GET" && path === "/api/health") {
      return json(200, { ok: true, service: "repayd-dashboard" });
    }
    if (req.method === "GET" && path.startsWith("/api/platforms/")) {
      const name = path.split("/").pop() ?? "";
      try {
        const res = await fetch(`${API}/v1/platforms/${name}`);
        const body = (await res.json()) as unknown;
        return json(res.status, body);
      } catch {
        return json(502, { error: "coverage api unreachable" });
      }
    }

    if (req.method === "GET" && (path === "/api/atlas/overview" || path === "/api/circle/agent-wallet")) {
      try {
        const res = await fetch(`${API}${path}`);
        const body = (await res.json()) as unknown;
        return json(res.status, body);
      } catch {
        return json(502, { error: "coverage api unreachable" });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

function html(page: "owner" | "capital" | "record"): Response {
  const file = join(import.meta.dir, "src", `${page}.html`);
  return new Response(readFileSync(file, "utf8"), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

console.log(`REPAYD dashboards on :${server.port} — / (owner) · /capital · /record`);
