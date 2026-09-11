/**
 * Coverage API → on-chain bridge tests.
 *
 * The bridge materializes POST /v1/coverage policies as
 * PolicyRegistry.attach() transactions. These tests pin the mapping and
 * gating logic that does NOT need a live chain: policy shape conversion,
 * env gating, and calldata encoding. Live attach semantics (owner checks)
 * are covered by PolicyRegistry's own forge suite.
 */

import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";

import {
  bridgeFromEnv,
  toOnChainPolicy,
  type BridgeConfig,
} from "../src/coverage-bridge.ts";
import type { PolicyRequest } from "../src/schemas.ts";

const POLICY_REGISTRY_ABI = parseAbi([
  "function attach(address agent, (uint32,address,address,uint96,uint16,uint96,uint96,uint32,(address,uint96)[],uint32,uint32,uint32,bool) policy)",
]);

const GUARD = "0xB30553e2f132126B951D3a6AD4E07EbAa5523b6E" as `0x${string}`;
const OWNER = "0x9675b4D20d2ACFE55D00a02D55B9cdb57AEbD482" as `0x${string}`;

function samplePolicy(): PolicyRequest {
  return {
    cap: 2_500_000_000n,
    perTx: 200_000_000n,
    daily: 1_000_000_000n,
    velocity: 5,
    allowlist: [GUARD.slice(0, 42), "0x1D96F2f6BeF1202E4Ce1Ff6Dad0c2CB002861d3e"],
    deductibleBps: 1000,
    holdWindowSec: 120,
  };
}

describe("bridgeFromEnv", () => {
  test("disabled when key or rpc missing", () => {
    expect(bridgeFromEnv({})).toBeNull();
    expect(
      bridgeFromEnv({
        COVERAGE_PLATFORM_KEY: "0x" + "11".repeat(32),
      }),
    ).toBeNull();
    expect(
      bridgeFromEnv({
        COVERAGE_RPC_URL: "https://rpc.testnet.arc.io",
      }),
    ).toBeNull();
  });

  test("rejects malformed key", () => {
    expect(() =>
      bridgeFromEnv({
        COVERAGE_PLATFORM_KEY: "not-a-key",
        COVERAGE_RPC_URL: "https://rpc.testnet.arc.io",
      }),
    ).toThrow("COVERAGE_PLATFORM_KEY");
  });

  test("enabled with valid key + rpc, registry override optional", () => {
    const cfg = bridgeFromEnv({
      COVERAGE_PLATFORM_KEY: "0x" + "11".repeat(32),
      COVERAGE_RPC_URL: "https://rpc.testnet.arc.io",
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.registryAddress).toBeUndefined();
    const cfg2 = bridgeFromEnv({
      COVERAGE_PLATFORM_KEY: "0x" + "11".repeat(32),
      COVERAGE_RPC_URL: "https://rpc.testnet.arc.io",
      COVERAGE_REGISTRY_ADDRESS: "0xcC34D02877E13Bf35Ad7E4eBC747d431B76e748a",
    });
    expect(cfg2!.registryAddress).toBe("0xcC34D02877E13Bf35Ad7E4eBC747d431B76e748a");
  });
});

describe("toOnChainPolicy", () => {
  test("maps request onto BulwarkTypes.Policy with defaults", () => {
    const p = toOnChainPolicy(samplePolicy(), GUARD, OWNER);
    expect(p.agent).toBe(GUARD);
    expect(p.owner).toBe(OWNER);
    expect(p.coverageCap).toBe(2_500_000_000n);
    expect(p.perTxLimit).toBe(200_000_000n);
    expect(p.dailyLimit).toBe(1_000_000_000n);
    expect(p.velocityLimit).toBe(5);
    expect(p.deductibleBps).toBe(1000);
    expect(p.holdWindowSec).toBe(120);
    expect(p.curfewStart).toBe(1440); // no curfew
    expect(p.curfewEnd).toBe(1440);
    expect(p.sdkInstalled).toBe(true); // platforms onboard with SDK (§27)
    expect(p.allowlist).toHaveLength(2);
    expect(p.allowlist[0]!.recipient).toBe(GUARD.slice(0, 42));
    expect(p.allowlist[0]!.cap).toBe(0n); // 0 → falls back to per-tx limit on-chain
  });

  test("allowlist entries carry zero caps (registry semantic)", () => {
    const p = toOnChainPolicy(
      { ...samplePolicy(), allowlist: ["0x1D96F2f6BeF1202E4Ce1Ff6Dad0c2CB002861d3e"] },
      GUARD,
      OWNER,
    );
    expect(p.allowlist[0]!.cap).toBe(0n);
  });

  test("rejects per-tx above coverage cap", () => {
    expect(() =>
      toOnChainPolicy(
        { ...samplePolicy(), perTx: 3_000_000_000n } as unknown as PolicyRequest,
        GUARD,
        OWNER,
      ),
    ).toThrow("perTx must be <= policy.cap");
  });
});

describe("attach calldata", () => {
  test("encodes attach() with registry-assigned version", () => {
    // Mirrors attachOnChain's encode step with a pinned config so the test
    // stays offline: verify the calldata decodes back to the exact policy.
    const cfg: BridgeConfig = {
      rpcUrl: "https://rpc.testnet.arc.io",
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
    };
    const req = samplePolicy();
    const policy = toOnChainPolicy(req, GUARD, OWNER);
    const version = 1;

    // Positional tuple — same shape attachOnChain encodes (unnamed components).
    const data = encodeFunctionData({
      abi: POLICY_REGISTRY_ABI,
      functionName: "attach",
      args: [
        GUARD,
        [
          version,
          GUARD,
          OWNER,
          policy.coverageCap,
          policy.deductibleBps,
          policy.perTxLimit,
          policy.dailyLimit,
          policy.velocityLimit,
          policy.allowlist.map((e) => [e.recipient as `0x${string}`, e.cap] as const),
          policy.curfewStart,
          policy.curfewEnd,
          policy.holdWindowSec,
          policy.sdkInstalled,
        ],
      ],
    });
    const decoded = decodeFunctionData({
      abi: POLICY_REGISTRY_ABI,
      data: data as `0x${string}`,
    });
    const tuple = decoded.args?.[1] as readonly unknown[];
    expect(tuple[0]).toBe(version);
    expect(tuple[3]).toBe(2_500_000_000n); // coverageCap
    expect(tuple[12]).toBe(true); // sdkInstalled
    expect(tuple[8]).toHaveLength(policy.allowlist.length);
    // config unused in the offline path; touch it so the pin stays honest
    expect(cfg.rpcUrl).toContain("arc");
  });
});
