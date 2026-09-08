/**
 * BULWARK Agent SDK — the alibi.
 *
 * Wraps the agent's instruction loop. Every instruction the agent receives —
 * from the owner's console, from a job, from a web page — is hashed and
 * appended to a rolling hash-chain:
 *
 *   entry = keccak(prev ‖ origin ‖ ownerSigned ‖ timestamp ‖ keccak(instruction))
 *
 * Owner-session instructions are signed with the owner's session key;
 * everything else is marked external. The chain head is committed for
 * ENSv2 publication and TEE co-signing.
 *
 * What the SDK never does (plan §31): hold keys, move funds on its own, or
 * see other agents' data. The owner keeps custody of everything.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

/** Where an instruction came from. */
export type Origin = "owner-console" | "job" | "web" | "tool";

export interface CommitOptions {
  readonly origin: Origin;
  readonly timestamp?: number;
}

/** One link in the instruction hash-chain. */
export interface ChainEntry {
  readonly digest: `0x${string}`; // keccak(prev ‖ fields ‖ keccak(instruction))
  readonly instructionHash: `0x${string}`; // keccak(instruction)
  readonly origin: Origin;
  readonly ownerSigned: boolean;
  readonly timestamp: number;
  readonly teeCosigned: boolean;
  readonly prev: `0x${string}`;
  /** ECDSA signature by the owner session key, when ownerSigned. */
  readonly signature?: `0x${string}`;
}

export interface BulwarkConfig {
  /** The agent's ENSv2 name, e.g. "atlas.bulwark.eth". */
  readonly agentName: string;
  /** Owner session private key (32 bytes hex) — bound to the World-ID login. */
  readonly sessionKey: `0x${string}`;
  /** TEE co-signing endpoint (Chainlink CRE). Optional in dev. */
  readonly teeEndpoint?: string;
  /**
   * Local JSON file the chain is appended to and reloaded from.
   * V1 stand-in for the planned ENSv2/TEE chain-head commitment — NOT the
   * final design; the file keeps the alibi across process restarts until
   * on-chain commitment lands. Optional: without it the chain is in-memory
   * only (as before), useful for tests and ephemeral runs.
   */
  readonly storePath?: string;
}

export class Bulwark {
  private readonly config: BulwarkConfig;
  private readonly sessionKeyBytes: Uint8Array;
  private readonly sessionPubkeyBytes: Uint8Array;
  private chain: ChainEntry[] = [];
  private readonly store: JsonChainStore;

  constructor(config: BulwarkConfig) {
    this.config = config;
    // Normalize once: accept 0x-prefixed or bare hex, 64 chars.
    const keyHex = config.sessionKey.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error("sessionKey must be a 32-byte hex string (with or without 0x)");
    }
    this.sessionKeyBytes = hexToBytes(keyHex);
    this.sessionPubkeyBytes = secp256k1.getPublicKey(this.sessionKeyBytes, true);
    this.store = new JsonChainStore(config.storePath);
    this.chain = this.store.load();
  }
  /** The current chain head (commit this to ENSv2 / TEE). */
  get head(): `0x${string}` {
    const last = this.chain[this.chain.length - 1];
    return (last?.digest ?? "0x0") satisfies `0x${string}`;
  }

  /** Full chain (for claim-time alibi inspection). */
  get entries(): readonly ChainEntry[] {
    return this.chain;
  }

  /** The owner session's public key — register this on-chain at signup. */
  get sessionPublicKey(): string {
    return bytesToHex(this.sessionPubkeyBytes);
  }

  /**
   * Commit an instruction to the chain. Hashes it, signs with the session
   * key iff it came from the owner's authenticated console, appends the
   * link. This is the ~50-line integration surface.
   */
  async commit(instruction: string, options: CommitOptions): Promise<ChainEntry> {
    const timestamp = options.timestamp ?? currentTimestamp();
    const instructionHash = keccakUtf8(instruction);
    const ownerSigned = options.origin === "owner-console";
    const prev = this.head;

    const digest = keccakPackedHex(
      concatHex(prev, toHex32(options.origin), ownerSigned ? "01" : "00", toHex32(timestamp), instructionHash),
    );

    let signature: `0x${string}` | undefined;
    if (ownerSigned) {
      const sig = secp256k1.sign(hexToBytes(digest.slice(2)), this.sessionKeyBytes);
      signature = `0x${sig.toCompactHex()}` as `0x${string}`;
    }

    const entry: ChainEntry = {
      digest,
      instructionHash,
      origin: options.origin,
      ownerSigned,
      timestamp,
      teeCosigned: await this.requestTeeCosign(digest),
      prev,
      signature,
    };
    this.chain.push(entry);
    this.store.save(this.chain);
    return entry;
  }

  /**
   * The claim-time alibi check (plan §10). Two lookup modes:
   *
   * 1. By FULL entry digest — the unambiguous identity of one chain link
   *    (it binds prev-hash, origin, timestamp, and instruction text).
   *    This is the preferred call: whoever holds the digest knows exactly
   *    which instruction executed.
   *
   * 2. By instruction text hash — allowed for compatibility, but the text
   *    hash does NOT identify a single link: the same text can legitimately
   *    appear in multiple entries (e.g. a recurring payroll instruction).
   *    When multiple entries share the text hash and disagree on
   *    ownerSigned, the lookup is AMBIGUOUS and resolves to DENY
   *    (ownerSigned: false). Deny-by-default: ambiguity must never pay out,
   *    or an owner could pre-commit attack text unsigned and then "execute"
   *    it via their signed console (the C4 bypass).
   *
   * When the resolved entry claims ownerSigned, its ECDSA signature is
   * verified — a forged flag cannot survive verification.
   */
  alibiFor(instructionHashOrDigest: `0x${string}`): { found: boolean; ownerSigned: boolean } {
    // 1. Exact-digest match wins: a digest identifies exactly one link.
    const byDigest = this.chain.find((e) => e.digest === instructionHashOrDigest);
    if (byDigest) return this.verdictFor(byDigest);

    // 2. Text-hash lookup: collect every entry sharing the instruction hash.
    const matches = this.chain.filter((e) => e.instructionHash === instructionHashOrDigest);
    if (matches.length === 0) return { found: false, ownerSigned: false };
    if (matches.length > 1 && matches.some((e) => e.ownerSigned !== matches[0]!.ownerSigned)) {
      // Same text committed both signed and unsigned — the executed
      // instruction cannot be attributed to either entry with certainty.
      // DENY THE CLAIM: report ownerSigned=true (owner-origin) so the
      // verdict engine routes to DENIED_OWNER_ORIGIN and pays nothing.
      // Covered-by-default here would resurrect the C4 bypass: an owner
      // pre-commits attack text unsigned, then executes it signed.
      return { found: true, ownerSigned: true };
    }
    return this.verdictFor(matches[0]!);
  }
  /** Signed entry → verify its signature; unsigned entry → external. */
  private verdictFor(entry: ChainEntry): { found: boolean; ownerSigned: boolean } {
    if (!entry.ownerSigned) return { found: true, ownerSigned: false };
    const ok = secp256k1.verify(
      hexToBytes(entry.signature?.slice(2) ?? ""),
      hexToBytes(entry.digest.slice(2)),
      this.sessionPubkeyBytes,
    );
    return { found: true, ownerSigned: ok };
  }
  /**
   * Chain integrity: every link's prev pointer connects, and every digest
   * recomputes. Any edit breaks the chain visibly.
   */
  verifyChain(): boolean {
    let expectedPrev = "0x0" as `0x${string}`;
    for (const e of this.chain) {
      if (e.prev !== expectedPrev) return false;
      const recomputed = keccakPackedHex(
        concatHex(e.prev, toHex32(e.origin), e.ownerSigned ? "01" : "00", toHex32(e.timestamp), e.instructionHash),
      );
      if (recomputed !== e.digest) return false;
      expectedPrev = e.digest;
    }
    return true;
  }

  private async requestTeeCosign(digest: `0x${string}`): Promise<boolean> {
    if (!this.config.teeEndpoint) return false; // dev mode: no TEE attached
    try {
      const res = await fetch(this.config.teeEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: this.config.agentName, digest }),
      });
      return res.ok;
    } catch {
      return false; // TEE unreachable — chain still valid, co-sign missing
    }
  }
}

// ------------------------------------------------------------------ //
//                          Hash helpers                              //
// ------------------------------------------------------------------ //

/**
 * keccak256 of a text string — UTF-8 bytes, UNCONDITIONALLY.
 *
 * Instruction text is never interpreted as hex, even when it looks like hex
 * ("deadbeef" is 8 UTF-8 bytes, not 4 raw bytes). The old hex-sniffing
 * heuristic made the hash of a text instruction depend on its characters —
 * an underspecified, un-reproducible contract for third-party re-runs.
 */
function keccakUtf8(text: string): `0x${string}` {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}` as `0x${string}`;
}

/**
 * keccak256 of a packed hex string (the digest formula's concatenated
 * 32-byte words). Input must be hex — by construction at every call site —
 * so an odd-length head like genesis "0x0" is left-padded to one byte.
 */
function keccakPackedHex(hex: string): `0x${string}` {
  const bare = hex.replace(/0x/gi, "");
  const even = bare.length % 2 === 0 ? bare : `0${bare}`;
  return `0x${bytesToHex(keccak_256(hexToBytes(even)))}` as `0x${string}`;
}

function concatHex(...parts: string[]): string {
  return parts.join("");
}

/** Left-pad a number/word to a 32-byte hex word. */
function toHex32(value: string | number): string {
  if (typeof value === "number") {
    return value.toString(16).padStart(64, "0");
  }
  // origin strings are short; encode as UTF-8 bytes into a 32-byte word.
  const bytes = Array.from(new TextEncoder().encode(value)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return bytes.padEnd(64, "0");
}

function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The published digest formula (plan §39: "anyone can re-run the
 * deterministic check on public data and compare digests").
 * entry digest = keccak(prev ‖ origin32 ‖ ownerSigned ‖ ts32 ‖ instructionHash)
 */
export function computeEntryDigest(
  prev: `0x${string}`,
  origin: Origin,
  ownerSigned: boolean,
  timestamp: number,
  instructionHash: `0x${string}`,
): `0x${string}` {
  return keccakPackedHex(
    concatHex(prev, toHex32(origin), ownerSigned ? "01" : "00", toHex32(timestamp), instructionHash),
  );
}

// ------------------------------------------------------------------ //
//                       Persistence (v1)                             //
// ------------------------------------------------------------------ //

/**
 * Append-only JSON chain store.
 *
 * V1 stand-in for the planned ENSv2/TEE chain-head commitment — NOT the
 * final design. Keeps the alibi alive across process restarts; tampering
 * with the file is detectable via verifyChain() (digests recompute from
 * stored fields), though the file itself is not adversarially protected —
 * the session-key signatures on ownerSigned entries are the tamper-evidence
 * that matters at claim time.
 */
class JsonChainStore {
  constructor(private readonly path: string | undefined) {}

  /** Load the chain from disk; missing/corrupt store → empty chain (fresh start). */
  load(): ChainEntry[] {
    if (!this.path) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { entries?: ChainEntry[] };
      return Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      return []; // unreadable store starts fresh rather than crashing the agent
    }
  }

  /** Persist the full chain. */
  save(entries: readonly ChainEntry[]): void {
    if (!this.path) return;
    writeFileSync(this.path, JSON.stringify({ version: 1, entries }, null, 2));
  }
}

export * from "./erc8004/index.ts";
