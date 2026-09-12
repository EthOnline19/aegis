/**
 * Circle Agent Stack gating tests.
 *
 * Pins the contract that matters for judging "effective use of Circle":
 *   1. No CIRCLE_API_KEY  → circleFromEnv null, dry-run, ZERO network calls.
 *   2. 2-part Console key → normalized to the TEST_API_KEY:<id>:<secret>
 *      form the API actually requires (verified live 2026-09: raw 2-part
 *      returns 401 "malformed API key"; prefixed returns 200).
 *   3. Configured + CIRCLE_DRY_RUN=1 → still dry-run, zero network.
 *   4. Live mode → authenticated reads against api.circle.com + Gateway;
 *      entity appId / wallet counts / gateway Arc balance surfaced;
 *      mutations (create/spend) stay PLANNED without CIRCLE_ENTITY_SECRET.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  agentWalletState,
  circleFromEnv,
  circleKeyFingerprint,
  planCircleCalls,
} from "../src/circle/agent-wallet.ts";

const GUARD = { address: "0xB30553e2f132126B951D3a6AD4E07EbAa5523b6E", usdcBalance: "5000000000" };

interface FetchSpy {
  readonly urls: string[];
  fetch: typeof globalThis.fetch;
}

/** Install a recording fetch; optional router maps URL fragment → JSON body. */
function installFetch(
  router?: (url: string) => { status: number; body: unknown } | undefined,
): FetchSpy {
  const spy: FetchSpy = { urls: [], fetch: null as unknown as typeof globalThis.fetch };
  spy.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    spy.urls.push(url);
    const hit = router?.(url);
    return new Response(JSON.stringify(hit?.body ?? { code: -1, message: "unmocked " + url }), {
      status: hit?.status ?? 404,
    });
  }) as unknown as typeof globalThis.fetch;
  globalThis.fetch = spy.fetch;
  return spy;
}

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

function route(responses: Record<string, unknown>) {
  return (url: string) => {
    for (const [frag, body] of Object.entries(responses)) {
      if (url.includes(frag)) return { status: 200, body };
    }
    return undefined;
  };
}

describe("circleFromEnv gating", () => {
  it("null when no key: integration disabled", () => {
    expect(circleFromEnv({})).toBeNull();
  });

  it("normalizes the Console 2-part key to the 3-part TEST_API_KEY form", () => {
    const cfg = circleFromEnv({ CIRCLE_API_KEY: "abc123:def456" });
    expect(cfg?.apiKey).toBe("TEST_API_KEY:abc123:def456");
    expect(cfg?.dryRun).toBe(false);
    expect(cfg?.entitySecret).toBeUndefined();
  });

  it("keeps a full 3-part key as-is", () => {
    const cfg = circleFromEnv({ CIRCLE_API_KEY: "TEST_API_KEY:abc123:def456" });
    expect(cfg?.apiKey).toBe("TEST_API_KEY:abc123:def456");
  });

  it("fingerprint is stable and key-redacting", () => {
    const a = circleFromEnv({ CIRCLE_API_KEY: "k1:s1" })!;
    const b = circleFromEnv({ CIRCLE_API_KEY: "k2:s2" })!;
    expect(circleKeyFingerprint(a)).toBe(circleKeyFingerprint(a));
    expect(circleKeyFingerprint(a)).not.toBe(circleKeyFingerprint(b));
    expect(circleKeyFingerprint(a)).toHaveLength(12);
  });
});

describe("dry-run default (no network, ever)", () => {
  it("unconfigured config → dry-run + planned calls, fetch never touched", async () => {
    const spy = installFetch();
    const state = await agentWalletState(null, GUARD);
    expect(state.mode).toBe("dry-run");
    expect(state.plannedCalls.length).toBeGreaterThan(0);
    expect(spy.urls).toHaveLength(0);
  });

  it("CIRCLE_DRY_RUN=1 forces dry-run even with a key", async () => {
    const spy = installFetch();
    const cfg = circleFromEnv({ CIRCLE_API_KEY: "abc:def", CIRCLE_DRY_RUN: "1" })!;
    const state = await agentWalletState(cfg, GUARD);
    expect(state.mode).toBe("dry-run");
    expect(spy.urls).toHaveLength(0);
  });

  it("planned calls name the real Circle endpoints incl. Gateway", () => {
    const paths = planCircleCalls({ demoSpend: true }).map((c) => c.path);
    expect(paths).toContain("/v1/w3s/developer/walletSets");
    expect(paths).toContain("/v1/w3s/developer/wallets");
    expect(paths.some((p) => p.startsWith("/v1/w3s/wallets?blockchain=ARC-TESTNET"))).toBe(true);
    expect(paths).toContain("/v1/balances");
    expect(paths).toContain("/v1/w3s/developer/transactions/transfer");
  });
});

describe("live mode reads (mocked Circle responses)", () => {
  it("reads entity config, wallet sets, wallets, and Gateway balance", async () => {
    const spy = installFetch(
      route({
        "/v1/w3s/config/entity": { data: { appId: "defb02cd-test" } },
        "/v1/w3s/walletSets": {
          data: { walletSets: [{ id: "set-1", name: "REPAYD Agent Treasury" }] },
        },
        "/v1/w3s/wallets?blockchain=ARC-TESTNET": {
          data: {
            wallets: [
              {
                id: "w-1",
                address: "0xagent",
                walletSetId: "set-1",
                balances: [{ token: { symbol: "USDC", address: "0x3600" }, amount: "7.25" }],
              },
            ],
          },
        },
        "gateway-api-testnet.circle.com/v1/balances": {
          token: "USDC",
          balances: [
            { domain: 26, depositor: GUARD.address, balance: "1.50", pendingBatch: "0" },
            { domain: 0, depositor: GUARD.address, balance: "0", pendingBatch: "0" },
          ],
        },
      }),
    );
    const cfg = circleFromEnv({ CIRCLE_API_KEY: "abc:def" })!;
    const state = await agentWalletState(cfg, GUARD);
    expect(state.mode).toBe("live");
    expect(state.entityAppId).toBe("defb02cd-test");
    expect(state.walletSetId).toBe("set-1");
    expect(state.walletAddress).toBe("0xagent");
    expect(state.circleUsdcBalance).toBe("7.25");
    expect(state.gatewayArcBalance).toBe("1.50");
    expect(state.gatewayDomains).toBe(2);
    expect(state.guardUsdcBalance).toBe("5000000000");
    // No entity secret → mutations stay planned, never fired.
    expect(state.plannedCalls.length).toBeGreaterThan(0);
    expect(spy.urls.some((u) => u.includes("/developer/walletSets"))).toBe(false);
    expect(spy.urls.some((u) => u.includes("/developer/transactions/transfer"))).toBe(false);
  });

  it("live with zero wallets still returns mode live + creation plan", async () => {
    installFetch(
      route({
        "/v1/w3s/config/entity": { data: { appId: "app-2" } },
        "/v1/w3s/walletSets": { data: { walletSets: [] } },
        "/v1/w3s/wallets?blockchain=ARC-TESTNET": { data: { wallets: [] } },
        "/v1/balances": { token: "USDC", balances: [] },
      }),
    );
    const cfg = circleFromEnv({ CIRCLE_API_KEY: "TEST_API_KEY:abc:def" })!;
    const state = await agentWalletState(cfg, GUARD);
    expect(state.mode).toBe("live");
    expect(state.walletCount).toBe(0);
    expect(state.plannedCalls.some((c) => c.path === "/v1/w3s/developer/walletSets")).toBe(true);
  });

  it("rejected key surfaces a real error, not a fake live", async () => {
    installFetch(() => ({ status: 401, body: { code: 401, message: "nope" } }));
    const cfg = circleFromEnv({ CIRCLE_API_KEY: "bad:key" })!;
    await expect(agentWalletState(cfg, GUARD)).rejects.toThrow(/key rejected/);
  });

  it("demo spend stays planned without entity secret", async () => {
    const spy = installFetch(
      route({
        "/v1/w3s/config/entity": { data: { appId: "app-3" } },
        "/v1/w3s/walletSets": { data: { walletSets: [] } },
        "/v1/w3s/wallets?blockchain=ARC-TESTNET": {
          data: {
            wallets: [
              {
                id: "w",
                address: "0xa",
                walletSetId: "s",
                balances: [{ token: { symbol: "USDC" }, amount: "3" }],
              },
            ],
          },
        },
        "/v1/balances": {
          token: "USDC",
          balances: [{ domain: 26, depositor: GUARD.address, balance: "0", pendingBatch: "0" }],
        },
      }),
    );
    const cfg = circleFromEnv({ CIRCLE_API_KEY: "a:b", CIRCLE_DEMO_SPEND: "1" })!;
    const state = await agentWalletState(cfg, GUARD);
    expect(state.demoSpend?.planned).toBe(true);
    expect(state.plannedCalls.some((c) => c.path.includes("/transactions/transfer"))).toBe(true);
    expect(spy.urls.some((u) => u.includes("/developer/transactions/transfer"))).toBe(false);
  });
});
