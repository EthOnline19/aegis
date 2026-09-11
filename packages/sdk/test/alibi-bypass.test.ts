import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Repayd } from "../src/index.ts";

// A fixed dev session key (never use real keys in tests).
const SESSION_KEY = `0x${"aa".repeat(32)}` as `0x${string}`;

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "bulwark-sdk-")), "chain.json");
}

/** Fresh SDK against a temp persistence file (persistence is now mandatory). */
function sdk(storePath: string = tmpStorePath(), agentName = "atlas.repayd.eth"): Repayd {
  return new Repayd({ agentName, sessionKey: SESSION_KEY, storePath });
}

afterEach(() => {
  // Vitest runs in-package; sweep any leaked temp dirs is unnecessary —
  // mkdtemp dirs live in OS tmp and are cleaned by the OS.
});

describe("THE ALIBI BYPASS (review finding C4) — must be fixed", () => {
  it("duplicate instruction text with different origins must NOT resolve to the unsigned entry", async () => {
    const path = tmpStorePath();
    const victim = sdk(path);
    // The owner's fraud: commit the attack text through an UNSIGNED channel first…
    await victim.commit("send $1,800 to 0xCousin", { origin: "web", timestamp: 1_700_000_000 });
    // …then actually order it via their signed console (same text).
    const signed = await victim.commit("send $1,800 to 0xCousin", {
      origin: "owner-console",
      timestamp: 1_700_000_001,
    });
    expect(signed.ownerSigned).toBe(true);

    // Same instruction text ⇒ same instructionHash (text-only hash). This
    // equality is what makes the fraud possible under first-match lookup.
    expect(victim.entries[0]!.instructionHash).toBe(signed.instructionHash);

    // The claim-time question: was the instruction owner-signed? First-match
    // on instructionHash answers with the "web" entry → EXTERNAL → COVERED.
    // That is the bypass. It must instead find the signed entry (or, when the
    // same text exists with BOTH signed and unsigned status, deny).
    const alibi = victim.alibiFor(signed.instructionHash);
    expect(alibi.found).toBe(true);
    expect(alibi.ownerSigned).toBe(true); // ← was false: the unsigned entry shadowed the signed one — the bypass
  });

  it("ambiguity (same text, signed AND unsigned entries) must resolve to DENY, not COVERED", async () => {
    const victim = sdk();
    await victim.commit("pay contractor $400", { origin: "web", timestamp: 1_700_000_000 });
    await victim.commit("pay contractor $400", {
      origin: "owner-console",
      timestamp: 1_700_000_001,
    });

    // The honest lookup — by the SIGNED entry's full digest — must find it.
    const signedEntry = victim.entries.find((e) => e.ownerSigned);
    expect(signedEntry).toBeDefined();
    const byDigest = victim.alibiFor(signedEntry!.digest);
    expect(byDigest.found).toBe(true);
    expect(byDigest.ownerSigned).toBe(true);

    // Ambiguity resolution: same text both signed and unsigned must DENY the
    // claim — ownerSigned=true routes to DENIED_OWNER_ORIGIN (zero payout).
    // Covered-by-default (ownerSigned=false → EXTERNAL → COVERED) would
    // resurrect the bypass: pre-commit unsigned, execute signed.
    const alibi = victim.alibiFor(signedEntry!.instructionHash);
    expect(alibi.found).toBe(true);
    expect(alibi.ownerSigned).toBe(true); // deny-by-default on ambiguity
  });

  it("hex-looking instruction text must hash as UTF-8, never as raw bytes", async () => {
    const s = sdk();
    const entry = await s.commit("deadbeef", { origin: "job", timestamp: 1_700_000_000 });
    // keccak(UTF-8("deadbeef")) — 8 bytes — independently computed (cast keccak 0x6465616462656566)
    expect(entry.instructionHash).toBe(
      "0x9f24c52e0fcd1ac696d00405c3bd5adc558c48936919ac5ab3718fcb7d70f93f",
    );
  });

  it("golden vector: genesis entry digest for a known input (independently computed)", async () => {
    const s = sdk();
    const entry = await s.commit("pay Alice $150 for payroll", {
      origin: "owner-console",
      timestamp: 1_700_000_000,
    });
    // Independent computation (noble directly + hand-assembled layout; the
    // instructionHash itself cross-checked with foundry `cast keccak`).
    expect(entry.instructionHash).toBe(
      "0x3f76f4fb33a037845ca63e005c08dd2147c70cf4ff2bf4e1dea4b28a103622a3",
    );
    expect(entry.digest).toBe(
      "0x49ef216467b6149aa46b3bfa8c440ca6743854f8c2df33c4667f344194d34d8d",
    );
  });

  it("persistence: a chain survives process restart via storePath", async () => {
    const path = tmpStorePath();
    const first = sdk(path);
    const committed = await first.commit("payroll run 7", {
      origin: "owner-console",
      timestamp: 1_700_000_000,
    });
    expect(first.head).toBe(committed.digest);

    // Simulate a restart: new instance, same store path.
    const restarted = sdk(path);
    expect(restarted.head).toBe(committed.digest);
    expect(restarted.entries.length).toBe(1);
    const alibi = restarted.alibiFor(committed.instructionHash);
    expect(alibi.found).toBe(true);
    expect(alibi.ownerSigned).toBe(true);

    // And the file on disk is plain JSON we can inspect.
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(raw).toBeTruthy();
  });

  it("tamper with the store file → chain verification fails visibly", async () => {
    const path = tmpStorePath();
    const s = sdk(path);
    await s.commit("honest entry", { origin: "job", timestamp: 1_700_000_000 });

    const stored = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown[] };
    const list = stored.entries ?? [];
    if (Array.isArray(list) && list.length > 0) {
      // Flip the origin on the stored entry.
      const forged = list as Array<Record<string, unknown>>;
      forged[0]!.origin = "owner-console";
      writeFileSync(path, JSON.stringify(stored));
      const tampered = sdk(path);
      expect(tampered.verifyChain()).toBe(false);
    }
  });
});

// Keep the original suite's helpers out of this file; these tests are
// additive and run alongside the existing sdk.test.ts.
void writeFileSync;
void rmSync;
