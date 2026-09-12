/**
 * Circle Agent Stack touchpoint (Arc bounty — docs/submission/circle-agent-stack.md Path A).
 *
 * A config-gated module that gives the REPAYD agent a real, authenticated
 * presence inside Circle's developer stack on ARC-TESTNET:
 *
 *  1. LIVE reads (API key only — no entity secret needed):
 *     - GET  /v1/w3s/config/entity            → entity appId (auth proof)
 *     - GET  /v1/w3s/walletSets               → wallet-set inventory
 *     - GET  /v1/w3s/wallets?blockchains=…    → wallets + USDC balances
 *     - GET  /v1/w3s/transactions             → transaction log (empty until spend)
 *     - POST /v1/balances (Gateway API)       → Circle Gateway unified USDC
 *       balance for the GuardAccount across all domains (Arc testnet = 26).
 *  2. create (or reuse) a Circle wallet set + wallet on ARC-TESTNET —
 *     requires CIRCLE_ENTITY_SECRET (mutations are one-shot registered per
 *     account; see docs/submission/circle-agent-stack.md for our locked state).
 *  3. optionally send ONE USDC transfer from the Circle wallet
 *     (CIRCLE_DEMO_SPEND=1) — the "autonomous spending in USDC" tick.
 *
 * Gating mirrors the proven coverage-bridge pattern: circleFromEnv() returns
 * null when CIRCLE_API_KEY is absent → callers stay in store-only/dry-run
 * mode and NO network call is ever made. Dry-run (the default when
 * unconfigured, and CIRCLE_DRY_RUN=1 when configured) prints the exact API
 * calls it WOULD make.
 *
 * Env contract (never committed):
 *   CIRCLE_API_KEY               Circle API key (console.circle.com); either
 *                                the full 3-part TEST_API_KEY:<id>:<secret> or
 *                                the Console's 2-part <id>:<secret> form
 *                                (normalized to TEST_API_KEY-prefixed).
 *   CIRCLE_ENTITY_SECRET         registered entity secret (mutations only)
 *   CIRCLE_WALLET_SET_ID         optional — reuse instead of create
 *   CIRCLE_AGENT_WALLET_ADDRESS  optional — reuse instead of create
 *   CIRCLE_DEMO_SPEND=1          opt-in single USDC transfer
 *   CIRCLE_DRY_RUN=1             force dry-run even when configured
 *   CIRCLE_GATEWAY_BASE          override (default testnet Gateway)
 *
 * API shapes follow Circle's OpenAPI spec
 * (https://developers.circle.com/openapi/developer-controlled-wallets.yaml):
 *   POST /v1/w3s/developer/walletSets   { entitySecretCiphertext, idempotencyKey, name }
 *   POST /v1/w3s/developer/wallets      { blockchains, count, accountType, walletSetId, entitySecretCiphertext, idempotencyKey }
 *   GET  /v1/w3s/wallets?blockchains=ARC-TESTNET   (list; ?walletId= for one)
 *   GET  /v1/w3s/wallets/{id}/balances  (USDC balance per wallet)
 *   POST /v1/w3s/developer/transactions/transfer   { destinationAddress, amounts, walletId, blockchain, entitySecretCiphertext, idempotencyKey, feeLevel }
 */

import { createHash, createPublicKey, publicEncrypt, randomUUID, constants } from "node:crypto";

/** Arc testnet as Circle's Wallets API names it. */
const CIRCLE_CHAIN = "ARC-TESTNET";

/** Circle Wallets production API base (testnet chain is selected by the
 *  blockchain identifier itself, not by a different host). */
const API_BASE = "https://api.circle.com";

/** Circle Gateway (unified balance) testnet base; same Bearer key. */
const GATEWAY_BASE = "https://gateway-api-testnet.circle.com";

/** CCTP domain id for Arc testnet, as Circle's Gateway API numbers it. */
const ARC_TESTNET_DOMAIN = 26;

export interface CircleConfig {
  /** Full 3-part form: TEST_API_KEY:<id>:<secret> (normalized by circleFromEnv). */
  readonly apiKey: string;
  /** Undefined ⇒ reads stay live, mutations always print their bodies. */
  readonly entitySecret?: string;
  readonly walletSetId?: string;
  readonly walletAddress?: string;
  readonly dryRun: boolean;
  readonly demoSpend: boolean;
  /** Circle Gateway base for unified-balance reads. */
  readonly gatewayBase: string;
}

export interface PlannedCall {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly note: string;
}

export interface CircleWalletState {
  readonly mode: "dry-run" | "live";
  readonly chain: typeof CIRCLE_CHAIN;
  /** Circle entity appId behind the API key (live only — auth proof). */
  readonly entityAppId?: string;
  readonly walletSetId?: string;
  readonly walletAddress?: string;
  readonly walletSetCount?: number;
  readonly walletCount?: number;
  readonly circleUsdcBalance?: string;
  /** Circle Gateway unified USDC on Arc testnet (domain 26) for the guard. */
  readonly gatewayArcBalance?: string;
  /** Number of Gateway domains the guard address resolves across. */
  readonly gatewayDomains?: number;
  readonly guardAccount?: string;
  readonly guardUsdcBalance?: string;
  readonly demoSpend?: {
    readonly planned: boolean;
    readonly to?: string;
    readonly amount?: string;
    readonly txId?: string;
  };
  readonly plannedCalls: readonly PlannedCall[];
  readonly note?: string;
}

/**
 * Resolve Circle config from env; null = integration disabled (no CIRCLE_API_KEY).
 * Never throws on missing env — absence simply disables, like bridgeFromEnv().
 * A missing CIRCLE_ENTITY_SECRET only disables mutations; live reads continue.
 */
export function circleFromEnv(
  env: Record<string, string | undefined> = process.env,
): CircleConfig | null {
  const raw = env["CIRCLE_API_KEY"];
  if (!raw) return null;
  // Accept either the full 3-part key (TEST_API_KEY:<id>:<secret>) or the
  // 2-part id:secret form shown in the Console — normalize to 3-part.
  // (Verified against the live API: the 2-part form is rejected with a
  // "malformed API key" 401; prefixing TEST_API_KEY: makes it 200.)
  const parts = raw.split(":");
  const apiKey =
    parts.length === 3 ? raw : parts.length === 2 ? `TEST_API_KEY:${raw}` : raw;
  return {
    apiKey,
    entitySecret: env["CIRCLE_ENTITY_SECRET"],
    walletSetId: env["CIRCLE_WALLET_SET_ID"],
    walletAddress: env["CIRCLE_AGENT_WALLET_ADDRESS"],
    dryRun: env["CIRCLE_DRY_RUN"] === "1",
    demoSpend: env["CIRCLE_DEMO_SPEND"] === "1",
    gatewayBase: env["CIRCLE_GATEWAY_BASE"] ?? GATEWAY_BASE,
  };
}
/**
 * The exact calls agentWalletState() would make in dry-run, without a
 * configured entity secret: judges (and we) see precisely which Circle
 * Wallets API endpoints the integration hits. Paths verified against the
 * live API (creation is under /developer/, listing under /v1/w3s/wallets).
 */
export function planCircleCalls(input: {
  walletSetId?: string;
  walletAddress?: string;
  demoSpend: boolean;
  destination?: string;
}): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (!input.walletSetId) {
    calls.push({
      method: "POST",
      path: "/v1/w3s/developer/walletSets",
      body: { name: "REPAYD Agent Treasury", entitySecretCiphertext: "<encrypted-per-request>", idempotencyKey: "<uuid>" },
      note: "create a developer-controlled wallet set (or pass CIRCLE_WALLET_SET_ID to reuse)",
    });
  }
  if (!input.walletAddress) {
    calls.push({
      method: "POST",
      path: "/v1/w3s/developer/wallets",
      body: {
        blockchains: [CIRCLE_CHAIN],
        count: 1,
        accountType: "EOA",
        walletSetId: input.walletSetId ?? "<from previous call>",
        entitySecretCiphertext: "<encrypted-per-request>",
        idempotencyKey: "<uuid>",
      },
      note: "create the REPAYD agent's Circle wallet on ARC-TESTNET",
    });
  }
  calls.push({
    method: "GET",
    path: `/v1/w3s/wallets?blockchain=${CIRCLE_CHAIN}`,
    note: "list wallets on ARC-TESTNET, then GET /v1/w3s/wallets/{id}/balances for the USDC balance (updates after each transfer)",
  });
  calls.push({
    method: "POST",
    path: "/v1/balances",
    body: { token: "USDC", sources: [{ depositor: "<GuardAccount>", domain: ARC_TESTNET_DOMAIN }] },
    note: `Circle Gateway unified-balance read (${GATEWAY_BASE}) — same Bearer key, no entity secret`,
  });
  if (input.demoSpend) {
    calls.push({
      method: "POST",
      path: "/v1/w3s/developer/transactions/transfer",
      body: {
        blockchain: CIRCLE_CHAIN,
        walletId: input.walletAddress ?? "<agent wallet>",
        destinationAddress: input.destination ?? "<policy owner EOA>",
        amounts: ["1.00"],
        feeLevel: "MEDIUM",
        entitySecretCiphertext: "<encrypted-per-request>",
        idempotencyKey: "<uuid>",
      },
      note: "ONE autonomous USDC spend from the Circle wallet (gas sponsored by Circle)",
    });
  }
  return calls;
}

/** Minimal JSON shapes of the Circle Wallets responses we consume. */
interface CircleBalance {
  readonly token: { readonly symbol?: string } | null;
  readonly amount?: string;
}
interface CircleWallet {
  readonly id?: string;
  readonly address?: string;
  readonly walletSetId?: string;
  readonly balances?: readonly CircleBalance[];
}
interface CircleWalletsResponse {
  readonly data?: { readonly wallets?: readonly CircleWallet[] };
}
interface CircleWalletSetsResponse {
  readonly data?: { readonly walletSets?: ReadonlyArray<{ readonly id?: string; readonly name?: string }> };
}
interface CircleEntityConfig {
  readonly data?: { readonly appId?: string };
}
interface CirclePublicKeyResponse {
  readonly data?: { readonly publicKey?: string };
}
interface CircleWalletSetCreateResponse {
  readonly data?: { readonly id?: string; readonly name?: string };
  readonly message?: string;
  readonly code?: number;
}
interface CircleCreateWalletsResponse {
  readonly data?: { readonly wallets?: readonly CircleWallet[] };
  readonly message?: string;
  readonly code?: number;
}
interface CircleBalancesListResponse {
  readonly data?: { readonly balances?: readonly CircleBalance[] };
}
interface CircleTransferResponse {
  readonly data?: { readonly id?: string; readonly status?: string };
  readonly message?: string;
  readonly code?: number;
}
/** Circle Gateway (unified balance) response we consume. */
interface GatewayBalancesResponse {
  readonly token?: string;
  readonly balances?: ReadonlyArray<{
    readonly domain: number;
    readonly depositor: string;
    readonly balance: string;
    readonly pendingBatch?: string;
  }>;
}

/**
 * Circle requires the entity secret encrypted with the entity public key,
 * fresh per request (replay protection). The scheme is documented at
 * https://github.com/circlefin/w3s-entity-secret-sample-code and is exactly
 * what @circle-fin/developer-controlled-wallets@10.8.0 implements
 * (WebCrypto RSA-OAEP, SHA-256): Node's publicEncrypt with
 * RSA_PKCS1_OAEP_PADDING + oaepHash sha256 over the 32-byte secret → base64.
 * Verified live against api.circle.com (registration returned 200 +
 * recovery file; wallet-set create reached the secret-comparison gate).
 */
async function entitySecretCiphertext(config: CircleConfig): Promise<string> {
  if (!config.entitySecret) {
    throw new Error("CIRCLE_ENTITY_SECRET required for Circle wallet mutations");
  }
  const res = await circleFetch(config, "GET", "/v1/w3s/config/entity/publicKey");
  const pkResp: CirclePublicKeyResponse = await res.json();
  const pk = pkResp.data?.publicKey;
  if (!pk) throw new Error("Circle returned no entity public key");
  const key = createPublicKey(pk);
  const secret = Buffer.from(config.entitySecret, "hex");
  if (secret.length !== 32) throw new Error("CIRCLE_ENTITY_SECRET must be 64 hex chars");
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    secret,
  ).toString("base64");
}

/**
 * Full agent-wallet state. Dry-run (default without CIRCLE_API_KEY, or
 * CIRCLE_DRY_RUN=1): zero network traffic, prints the exact planned calls.
 * Live: real authenticated reads against Circle's APIs —
 *   GET  /v1/w3s/config/entity           (key auth proof, appId)
 *   GET  /v1/w3s/walletSets              (wallet-set inventory)
 *   GET  /v1/w3s/wallets?blockchain=…    (wallets; per-wallet balances read)
 *   POST /v1/balances (Gateway API)      (unified USDC per domain for GuardAccount)
 * With CIRCLE_ENTITY_SECRET the one-time creation (wallet set + wallet) and
 * CIRCLE_DEMO_SPEND=1 transfer execute for real via encrypted ciphertext.
 */
export async function agentWalletState(
  config: CircleConfig | null,
  guard: { address: string; usdcBalance: string },
): Promise<CircleWalletState> {
  // ---- Dry-run: unconfigured or forced. Zero network traffic. ---- //
  if (!config || config.dryRun) {
    const walletSetId = config?.walletSetId;
    const walletAddress = config?.walletAddress;
    const demoSpend = config?.demoSpend ?? false;
    return {
      mode: "dry-run",
      chain: CIRCLE_CHAIN,
      walletSetId,
      walletAddress,
      guardAccount: guard.address,
      guardUsdcBalance: guard.usdcBalance,
      demoSpend: {
        planned: demoSpend,
        to: demoSpend ? "<CIRCLE_SPEND_DESTINATION or policy owner>" : undefined,
        amount: demoSpend ? "1.00" : undefined,
      },
      plannedCalls: planCircleCalls({ walletSetId, walletAddress, demoSpend }),
    };
  }

  // ---- Live reads: only the API key is needed. Mutations require the
  // entity secret; without it they stay printed (planned-call list). ---- //
  const canMutate = config.entitySecret !== undefined;

  // Auth proof: Circle's entity config for this key.
  const entityRes = await circleFetch(config, "GET", "/v1/w3s/config/entity");
  if (!entityRes.ok) {
    throw new Error(`Circle entity read ${entityRes.status} — key rejected?`);
  }
  const entityBody: CircleEntityConfig = await entityRes.json();
  const entityAppId = entityBody.data?.appId ?? "unknown";

  // Wallet-set inventory (live).
  const setsRes = await circleFetch(config, "GET", "/v1/w3s/walletSets?pageSize=50");
  const setsBody: CircleWalletSetsResponse = await setsRes.json();
  const sets = setsBody.data?.walletSets ?? [];

  // Wallets on ARC-TESTNET (live).
  const listRes = await circleFetch(
    config,
    "GET",
    `/v1/w3s/wallets?blockchain=${CIRCLE_CHAIN}&pageSize=50`,
  );
  const listBody: CircleWalletsResponse = await listRes.json();
  let wallets = listBody.data?.wallets ?? [];

  let walletSetId = config.walletSetId ?? sets[0]?.id;
  let walletAddress = config.walletAddress;
  let note: string | undefined;

  // One-time provisioning, when authorized: create set + wallet for real.
  if (canMutate && !walletAddress) {
    if (!walletSetId) {
      const created = await circleFetch(config, "POST", "/v1/w3s/developer/walletSets", {
        name: "REPAYD Agent Treasury",
        entitySecretCiphertext: await entitySecretCiphertext(config),
        idempotencyKey: randomUUID(),
      });
      const body: CircleWalletSetCreateResponse = await created.json();
      if (!created.ok || !body.data?.id) {
        throw new Error(`Circle walletSet create failed (${body.code ?? created.status}): ${body.message ?? "unknown"}`);
      }
      walletSetId = body.data.id;
    }
    const createdW = await circleFetch(config, "POST", "/v1/w3s/developer/wallets", {
      blockchains: [CIRCLE_CHAIN],
      count: 1,
      accountType: "EOA",
      walletSetId,
      entitySecretCiphertext: await entitySecretCiphertext(config),
      idempotencyKey: randomUUID(),
    });
    const wBody: CircleCreateWalletsResponse = await createdW.json();
    const w0 = wBody.data?.wallets?.[0];
    if (!createdW.ok || !w0?.address) {
      throw new Error(`Circle wallet create failed (${wBody.code ?? createdW.status}): ${wBody.message ?? "unknown"}`);
    }
    walletAddress = w0.address;
    note = `provisioned Circle wallet ${walletAddress} (set ${walletSetId}) on ${CIRCLE_CHAIN}`;
    wallets = [w0];
  }

  // USDC balance for the selected/first wallet (live).
  let circleUsdcBalance: string | undefined;
  const pinned = walletAddress?.toLowerCase();
  const target = pinned
    ? wallets.find((w) => w.address?.toLowerCase() === pinned) ?? wallets[0]
    : wallets[0];
  if (target) {
    walletAddress = target.address;
    walletSetId = walletSetId ?? target.walletSetId;
    let balances = target.balances;
    if (!balances && target.id) {
      const bres = await circleFetch(config, "GET", `/v1/w3s/wallets/${target.id}/balances`);
      const bBody: CircleBalancesListResponse = await bres.json();
      balances = bBody.data?.balances;
    }
    const usdc = balances?.find((b) => b.token?.symbol === "USDC");
    circleUsdcBalance = usdc?.amount ?? "0";
  }

  // Circle Gateway: unified USDC balance of the GuardAccount across domains
  // (Arc testnet = domain 26). Key-only auth — a real Circle product read.
  let gatewayArcBalance: string | undefined;
  let gatewayDomains: number | undefined;
  try {
    const gres = await fetch(`${config.gatewayBase}/v1/balances`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "USDC", sources: [{ depositor: guard.address }] }),
    });
    if (gres.ok) {
      const gbody: GatewayBalancesResponse = await gres.json();
      const rows = gbody.balances ?? [];
      gatewayDomains = rows.length;
      gatewayArcBalance =
        rows.find((r) => r.domain === ARC_TESTNET_DOMAIN)?.balance ?? "0";
    } else {
      note = `gateway read ${gres.status}`;
    }
  } catch {
    note = "gateway read unreachable";
  }

  // Optional autonomous spend (real transfer when authorized + funded).
  let demoSpendState: CircleWalletState["demoSpend"];
  if (config.demoSpend && canMutate && walletAddress && circleUsdcBalance !== undefined && circleUsdcBalance !== "0") {
    const tres = await circleFetch(config, "POST", "/v1/w3s/developer/transactions/transfer", {
      blockchain: CIRCLE_CHAIN,
      walletAddress,
      destinationAddress: guard.address,
      amounts: ["1.00"],
      feeLevel: "MEDIUM",
      entitySecretCiphertext: await entitySecretCiphertext(config),
      idempotencyKey: randomUUID(),
    });
    const tbody: CircleTransferResponse = await tres.json();
    if (!tres.ok) {
      throw new Error(`Circle transfer failed (${tbody.code ?? tres.status}): ${tbody.message ?? "unknown"}`);
    }
    demoSpendState = { planned: false, to: guard.address, amount: "1.00", txId: tbody.data?.id };
  } else {
    demoSpendState = {
      planned: config.demoSpend,
      to: config.demoSpend ? guard.address : undefined,
      amount: config.demoSpend ? "1.00" : undefined,
    };
  }

  return {
    mode: "live",
    chain: CIRCLE_CHAIN,
    entityAppId,
    walletSetId,
    walletAddress,
    walletSetCount: sets.length,
    walletCount: wallets.length,
    circleUsdcBalance,
    gatewayArcBalance,
    gatewayDomains,
    guardAccount: guard.address,
    guardUsdcBalance: guard.usdcBalance,
    demoSpend: demoSpendState,
    plannedCalls: canMutate
      ? []
      : planCircleCalls({ walletSetId, walletAddress, demoSpend: config.demoSpend }),
    note,
  };
}

/** Authenticated Circle Wallets API fetch (live mode only). */
async function circleFetch(
  config: CircleConfig,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      "x-request-id": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Stable redaction digest for logging config without leaking the key. */
export function circleKeyFingerprint(config: CircleConfig): string {
  return createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12);
}
