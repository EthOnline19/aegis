import { describe, expect, it } from "vitest";
import {
  buildRegistrationPlan,
  dnsEncodeForTest,
  ENSV2_ADDRESSES,
  ENSV2_TEXT_KEYS,
  makeCommitment,
  renderForChain,
  resolverProxySalt,
  writerGate,
} from "../src/ensv2.ts";
import { buildResume, type ResumeInput } from "../src/resume.ts";

const OWNER = "0xB30553e2f132126B951D3a6AD4E07EbAa5523b6E" as const;
const SECRET = "0x" + "ab".repeat(32) as `0x${string}`;
const CHAIN_HEAD = "0x" + "cd".repeat(32) as `0x${string}`;

const DEMO: ResumeInput = {
  policy: { version: 4, capUsd: 2500, poolHealthy: true },
  driving: { cleanDays: 179, score: 94, premiumMultiplier: 0.72 },
  claims: { covered: 1, attempted: 1, payoutsUsd: [135] },
  alibi: { installed: true, instructionChainLive: true },
  backing: { worldIdVerified: true },
  status: "ACTIVE",
};

describe("buildRegistrationPlan", () => {
  const plan = buildRegistrationPlan({
    label: "bulwark",
    owner: OWNER,
    secret: SECRET,
    resume: buildResume(DEMO),
    chainHead: CHAIN_HEAD,
  });

  it("plans a 4-tx flow: deployProxy → approve → commit → register", () => {
    expect(plan.name).toBe("bulwark.eth");
    expect(plan.resolverDeploy.to).toBe(ENSV2_ADDRESSES.verifiableFactory);
    expect(plan.approve.spender).toBe(ENSV2_ADDRESSES.ethRegistrar);
    expect(plan.commit.to).toBe(ENSV2_ADDRESSES.ethRegistrar);
    expect(plan.register.to).toBe(ENSV2_ADDRESSES.ethRegistrar);
    expect(plan.waitSeconds).toBe(60);
  });

  it("bakes the résumé + chainhead text records into the resolver init setters", () => {
    expect(plan.textRecords[ENSV2_TEXT_KEYS.resume]).toContain("179-day clean streak");
    expect(plan.textRecords[ENSV2_TEXT_KEYS.resume]).toContain("World-ID verified human");
    expect(plan.textRecords[ENSV2_TEXT_KEYS.chainhead]).toBe(CHAIN_HEAD);
    // per-field keys also present
    expect(plan.textRecords["com.bulwark.insured"]).toContain("policy v4");
    expect(plan.resolverDeploy.data).toMatch(/^0x[0-9a-f]+$/);
  });

  it("binds all 7 params in the commitment (anti-frontrun)", () => {
    const again = makeCommitment({
      label: "bulwark",
      owner: OWNER,
      secret: SECRET,
      subregistry: `0x${"00".repeat(20)}`,
      resolver: plan.resolver,
      duration: 60n * 60n * 24n * 365n,
      referrer: `0x${"00".repeat(32)}`,
    });
    expect(plan.commit.commitment).toBe(again);
    // different label → different commitment
    const other = makeCommitment({
      label: "atlasbulwark",
      owner: OWNER,
      secret: SECRET,
      subregistry: `0x${"00".repeat(20)}`,
      resolver: plan.resolver,
      duration: 60n * 60n * 24n * 365n,
      referrer: `0x${"00".repeat(32)}`,
    });
    expect(other).not.toBe(plan.commit.commitment);
  });

  it("resolver proxy salt is deterministic per owner", () => {
    expect(resolverProxySalt(OWNER)).toBe(resolverProxySalt(OWNER));
    expect(resolverProxySalt(OWNER)).not.toBe(resolverProxySalt(`0x${"11".repeat(20)}`));
  });
});

describe("writer gate", () => {
  it("blocks writes unless both env keys are set", () => {
    expect(writerGate({})).toEqual({
      allowed: false,
      missing: ["ENSETH_PRIVATE_KEY", "ENSV2_RPC_URL"],
    });
    expect(writerGate({ ENSETH_PRIVATE_KEY: "0xabc" })).toEqual({
      allowed: false,
      missing: ["ENSV2_RPC_URL"],
    });
    expect(
      writerGate({ ENSETH_PRIVATE_KEY: "0xabc", ENSV2_RPC_URL: "https://sepolia" }),
    ).toEqual({ allowed: true, missing: [] });
  });
});

describe("renderForChain", () => {
  it("renders the §13 block with the COMPUTED label riding the DRIVING line", () => {
    const block = renderForChain(buildResume(DEMO));
    expect(block.split("\n").map((l) => l.split(":")[0])).toEqual([
      "INSURED",
      "DRIVING",
      "CLAIMS",
      "ALIBI SDK",
      "BACKING",
      "STATUS",
    ]);
    expect(block).toContain("premium 0.72x [COMPUTED]");
  });
});

describe("dnsEncodeForTest", () => {
  it("encodes bulwark.eth as wire-format DNS labels", () => {
    const bytes = dnsEncodeForTest("bulwark.eth");
    expect(Array.from(bytes)).toEqual([
      7, ...[...bulwarkBytes()], 3, ...[...ethBytes()], 0,
    ]);
  });
});

function bulwarkBytes(): Uint8Array {
  return new TextEncoder().encode("bulwark");
}
function ethBytes(): Uint8Array {
  return new TextEncoder().encode("eth");
}
