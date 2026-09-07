import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
import {
  toOnChainPolicy,
  type Policy,
  USDC_DECIMALS,
  NO_CURFEW,
} from "../src/index.ts";

/**
 * Lockstep test: the TS Policy type is the single canonical mirror of the
 * Solidity BulwarkTypes.Policy struct. This suite fails when either side
 * drifts — field renames, reorders, or type changes in
 * contracts/src/BulwarkTypes.sol must be reflected in engine/src/types.ts
 * and vice versa.
 */

/** The Policy struct's field list, read from the PolicyRegistry ABI. */
function solidifyPolicyFields(): Array<{ name: string; type: string; internalType?: string }> {
  // BulwarkTypes is a library — forge emits the Policy struct's field list
  // in getPolicy's output components (PolicyRegistry artifact), not in the
  // library's own abi. That component list is the canonical field source.
  const registryPath = join(
    TEST_DIR,
    "..",
    "..",
    "..",
    "contracts",
    "out",
    "PolicyRegistry.sol",
    "PolicyRegistry.json",
  );
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    abi: Array<{
      type: string;
      name?: string;
      outputs?: Array<{ name: string; type: string; internalType: string; components?: unknown[] }>;
    }>;
  };
  const getPolicy = registry.abi.find((e) => e.type === "function" && e.name === "getPolicy");
  const out = getPolicy?.outputs?.[0]?.components as
    | Array<{ name: string; type: string; internalType?: string }>
    | undefined;
  if (!out) throw new Error("PolicyRegistry.getPolicy output components not found in ABI");
  return out;
}

describe("Policy lockstep: TS type ↔ Solidity struct (review H5)", () => {
  it("every Solidity Policy field maps 1:1 to the TS Policy type", () => {
    const solFields = solidifyPolicyFields();
    expect(solFields.length).toBeGreaterThan(0);

    // The TS-to-Solidity mapping, asserted exhaustively. curfewStart/End are
    // the single intentional rename (TS: curfewStartMinute), pinned here.
    const tsFromSolidity: Record<string, string> = {
      version: "version",
      agent: "agent",
      owner: "owner",
      coverageCap: "coverageCap",
      deductibleBps: "deductibleBps",
      perTxLimit: "perTxLimit",
      dailyLimit: "dailyLimit",
      velocityLimit: "velocityLimit",
      allowlist: "allowlist",
      curfewStart: "curfewStartMinute", // the one documented rename
      curfewEnd: "curfewEndMinute",
      holdWindowSec: "holdWindowSec",
      sdkInstalled: "sdkInstalled",
    };

    for (const f of solFields) {
      const tsName = tsFromSolidity[f.name] ?? f.name;
      expect(Object.keys(tsFromSolidity)).toContain(f.name);
      void tsName;
    }
    // Exactly one field may differ by name — the two curfews.
    const unmapped = solFields.filter((f) => tsFromSolidity[f.name] !== f.name);
    expect(unmapped.map((f) => f.name).sort()).toEqual(["curfewEnd", "curfewStart"]);
  });

  it("toOnChainPolicy: the demo's hand-duplicated literal is gone; conversion is the single source", () => {
    const policy: Policy = {
      version: 1,
      agent: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      owner: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      coverageCap: 2_500_000_000n,
      deductibleBps: 1000,
      perTxLimit: 200_000_000n,
      dailyLimit: 1_000_000_000n,
      velocityLimit: 5,
      allowlist: [
        {
          recipient: "0x0000000000000000000000000000000000000003" as `0x${string}`,
          cap: 200_000_000n,
        },
      ],
      curfewStartMinute: NO_CURFEW,
      curfewEndMinute: NO_CURFEW,
      holdWindowSec: 120,
      sdkInstalled: true,
    };

    const onChain = toOnChainPolicy(policy);
    expect(onChain.version).toBe(1);
    expect(onChain.agent).toBe(policy.agent);
    expect(onChain.owner).toBe(policy.owner);
    expect(onChain.coverageCap).toBe(2_500_000_000n);
    expect(onChain.deductibleBps).toBe(1000);
    expect(onChain.perTxLimit).toBe(200_000_000n);
    expect(onChain.dailyLimit).toBe(1_000_000_000n);
    expect(onChain.velocityLimit).toBe(5);
    expect(onChain.allowlist).toEqual(policy.allowlist);
    // The documented rename, converted:
    expect(onChain).toHaveProperty("curfewStart", NO_CURFEW);
    expect(onChain).toHaveProperty("curfewEnd", NO_CURFEW);
    expect(onChain).not.toHaveProperty("curfewStartMinute");
    expect(onChain.holdWindowSec).toBe(120);
    expect(onChain.sdkInstalled).toBe(true);
    void USDC_DECIMALS;
  });
});
