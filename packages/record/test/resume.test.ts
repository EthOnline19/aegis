import { describe, expect, it } from "vitest";
import {
  buildResume,
  fromEnsTextRecords,
  parseEnsTextValue,
  renderResume,
  toEnsTextRecords,
  type ResumeInput,
} from "../src/resume.ts";

/**
 * The §35 demo record — what atlas.repayd.eth resolves to after the
 * Step-4 run: 179 clean days, 0.72x premium multiplier, 1 covered claim
 * ($135, same-block payout), 1 attempted breach (frozen hold, no loss).
 */
const DEMO: ResumeInput = {
  policy: { version: 4, capUsd: 2500, poolHealthy: true },
  driving: { cleanDays: 179, score: 94, premiumMultiplier: 0.72 },
  claims: { covered: 1, attempted: 1, payoutsUsd: [135] },
  alibi: { installed: true, instructionChainLive: true },
  backing: { worldIdVerified: true },
  status: "ACTIVE",
};

describe("buildResume — §13/§35 demo values", () => {
  it("renders the six §13 fields in order with the demo values", () => {
    const resume = buildResume(DEMO);
    const lines = renderResume(resume).split("\n");
    expect(lines.map((l) => l.split(":")[0]?.trim())).toEqual([
      "INSURED",
      "DRIVING",
      "CLAIMS",
      "ALIBI SDK",
      "BACKING",
      "STATUS",
    ]);
    expect(lines[0]).toContain("yes · policy v4 · cap $2,500 · pool healthy");
    expect(lines[1]).toContain("94/100 · 179-day clean streak · premium 0.72x");
    expect(lines[2]).toContain("1 covered ($135) · 1 attempted (frozen, no loss)");
    expect(lines[3]).toContain("installed (instruction chain live)");
    expect(lines[4]).toContain("World-ID verified human");
    expect(lines[5]).toContain("ACTIVE");
  });

  it("labels DRIVING as COMPUTED (pricing-formula output) and the rest VERIFIED", () => {
    const resume = buildResume(DEMO);
    expect(resume.DRIVING.provenance).toBe("COMPUTED");
    for (const key of ["INSURED", "CLAIMS", "ALIBI", "BACKING", "STATUS"] as const) {
      expect(resume[key].provenance).toBe("VERIFIED");
    }
  });

  it("is deterministic — same input, same résumé", () => {
    expect(renderResume(buildResume(DEMO))).toBe(renderResume(buildResume(DEMO)));
  });
});

describe("buildResume — edge records", () => {
  it("renders the virgin agent (day zero, no SDK, unverified)", () => {
    const resume = buildResume({
      policy: { version: 1, capUsd: 500, poolHealthy: true },
      driving: { cleanDays: 0, score: 100, premiumMultiplier: 0.9 },
      claims: { covered: 0, attempted: 0, payoutsUsd: [] },
      alibi: { installed: false, instructionChainLive: false },
      backing: { worldIdVerified: false },
      status: "ACTIVE",
    });
    expect(resume.INSURED.text).toBe("yes · policy v1 · cap $500 · pool healthy");
    expect(resume.DRIVING.text).toBe("100/100 · 0-day clean streak · premium 0.90x");
    expect(resume.CLAIMS.text).toBe("0 covered · 0 attempted");
    expect(resume.ALIBI.text).toBe("not installed");
    expect(resume.BACKING.text).toBe("unverified backing");
  });

  it("sums multiple payouts into the covered amount", () => {
    const resume = buildResume({
      ...DEMO,
      claims: { covered: 2, attempted: 0, payoutsUsd: [135, 162] },
    });
    expect(resume.CLAIMS.text).toBe("2 covered ($297) · 0 attempted");
  });

  it("flags an unhealthy pool instead of lying", () => {
    const resume = buildResume({
      ...DEMO,
      policy: { version: 4, capUsd: 2500, poolHealthy: false },
    });
    expect(resume.INSURED.text).toContain("pool under strain");
  });

  it("omits the premium when no multiplier is supplied", () => {
    const resume = buildResume({ ...DEMO, driving: { cleanDays: 179, score: 94 } });
    expect(resume.DRIVING.text).toBe("94/100 · 179-day clean streak");
  });
});

describe("ENS text records", () => {
  it("round-trips every field through the com.bulwark.* keys with provenance intact", () => {
    const resume = buildResume(DEMO);
    const records = toEnsTextRecords(resume);
    expect(Object.keys(records).sort()).toEqual([
      "com.bulwark.alibi",
      "com.bulwark.backing",
      "com.bulwark.claims",
      "com.bulwark.driving",
      "com.bulwark.insured",
      "com.bulwark.status",
    ]);
    expect(records["com.bulwark.insured"]).toBe(
      "yes · policy v4 · cap $2,500 · pool healthy [VERIFIED]",
    );
    expect(records["com.bulwark.driving"]).toBe(
      "94/100 · 179-day clean streak · premium 0.72x [COMPUTED]",
    );
    const back = fromEnsTextRecords(records);
    expect(back.DRIVING).toEqual({
      text: "94/100 · 179-day clean streak · premium 0.72x",
      provenance: "COMPUTED",
    });
    expect(back.INSURED?.provenance).toBe("VERIFIED");
  });

  it("treats a malformed record as COMPUTED rather than inventing a label", () => {
    expect(parseEnsTextValue("no label here")).toEqual({
      text: "no label here",
      provenance: "COMPUTED",
    });
  });
});
