/**
 * BULWARK Coverage API — request/response schemas.
 *
 * External input enters here and nowhere else: every request body is
 * parsed through these validators before it touches the store.
 */

export interface PolicyRequest {
  readonly cap: bigint; // USDC base units
  readonly perTx: bigint;
  readonly daily: bigint;
  readonly velocity: number;
  readonly allowlist: readonly string[];
  readonly deductibleBps?: number;
  readonly holdWindowSec?: number;
}

export interface CoverageRequest {
  readonly agentWallet: string;
  readonly policy: PolicyRequest;
  readonly platform: string;
  readonly watchOnly?: boolean;
}

export interface CoverageResponse {
  readonly policyId: string;
  readonly premiumStream: string; // human-readable, e.g. "0.31%/mo-equiv"
  readonly record: string; // ENSv2 name
  readonly multiplier: number;
  readonly monthlyPremium: bigint;
}

/** Parse + validate a coverage request. Throws with a field-level message. */
export function parseCoverageRequest(input: unknown): CoverageRequest {
  if (typeof input !== "object" || input === null) throw new Error("body must be an object");
  const body = input as Record<string, unknown>;

  const agentWallet = requireString(body["agentWallet"], "agentWallet");
  if (!/^0x[0-9a-fA-F]{40}$/.test(agentWallet)) {
    throw new Error("agentWallet must be a 0x-prefixed 20-byte address");
  }
  const platform = requireString(body["platform"], "platform");
  if (platform.length === 0 || platform.length > 64) {
    throw new Error("platform must be 1-64 chars");
  }

  const policyRaw = body["policy"];
  if (typeof policyRaw !== "object" || policyRaw === null) throw new Error("policy required");
  const policy = policyRaw as Record<string, unknown>;

  const cap = requireUint(policy["cap"], "policy.cap");
  const perTx = requireUint(policy["perTx"], "policy.perTx");
  const daily = requireUint(policy["daily"], "policy.daily");
  const velocity = requireUint(policy["velocity"], "policy.velocity");
  if (perTx === 0n || cap === 0n || daily === 0n) throw new Error("policy amounts must be > 0");
  if (daily < perTx) throw new Error("policy.daily must be >= policy.perTx");
  if (perTx > cap) throw new Error("policy.perTx must be <= policy.cap");

  const allowlistRaw = policy["allowlist"];
  if (!Array.isArray(allowlistRaw)) throw new Error("policy.allowlist required");
  for (const a of allowlistRaw) {
    if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
      throw new Error("policy.allowlist entries must be addresses");
    }
  }

  const deductibleRaw = policy["deductibleBps"] ?? 1000;
  if (typeof deductibleRaw !== "number" || deductibleRaw < 0 || deductibleRaw > 5000) {
    throw new Error("policy.deductibleBps must be 0-5000");
  }
  const holdRaw = policy["holdWindowSec"] ?? 120;
  if (typeof holdRaw !== "number" || holdRaw < 30 || holdRaw > 3600) {
    throw new Error("policy.holdWindowSec must be 30-3600");
  }

  const watchOnly = body["watchOnly"] === true;

  return {
    agentWallet,
    platform,
    watchOnly,
    policy: {
      cap,
      perTx,
      daily,
      velocity: Number(velocity),
      allowlist: allowlistRaw as readonly string[],
      deductibleBps: deductibleRaw,
      holdWindowSec: holdRaw,
    },
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function requireUint(value: unknown, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${field} must be >= 0`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${field} must be a non-negative integer`);
}
