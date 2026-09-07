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
}

export class Bulwark {
  private readonly config: BulwarkConfig;
  private readonly sessionPubkeyBytes: Uint8Array;
  private chain: ChainEntry[] = [];

  constructor(config: BulwarkConfig) {
    this.config = config;
    this.sessionPubkeyBytes = secp256k1.getPublicKey(hexToBytes(config.sessionKey.slice(2)), true);
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
    const instructionHash = keccakHex(instruction);
    const ownerSigned = options.origin === "owner-console";
    const prev = this.head;

    const digest = keccakHex(
      concatHex(prev, toHex32(options.origin), ownerSigned ? "01" : "00", toHex32(timestamp), instructionHash),
    );

    let signature: `0x${string}` | undefined;
    if (ownerSigned) {
      const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(this.config.sessionKey.slice(2)));
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
    return entry;
  }

  /**
   * The claim-time alibi check (plan §10): does the chain contain the
   * instruction that produced `instructionHash`, and was it owner-signed?
   */
  alibiFor(instructionHash: `0x${string}`): { found: boolean; ownerSigned: boolean } {
    const entry = this.chain.find((e) => e.instructionHash === instructionHash);
    if (!entry) return { found: false, ownerSigned: false };
    // Verify the owner signature when present — a forged ownerSigned flag
    // cannot survive signature verification.
    if (entry.ownerSigned) {
      const ok = secp256k1.verify(
        hexToBytes(entry.signature?.slice(2) ?? ""),
        hexToBytes(entry.digest.slice(2)),
        this.sessionPubkeyBytes,
      );
      return { found: true, ownerSigned: ok };
    }
    return { found: true, ownerSigned: false };
  }

  /**
   * Chain integrity: every link's prev pointer connects, and every digest
   * recomputes. Any edit breaks the chain visibly.
   */
  verifyChain(): boolean {
    let expectedPrev = "0x0" as `0x${string}`;
    for (const e of this.chain) {
      if (e.prev !== expectedPrev) return false;
      const recomputed = keccakHex(
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

/** keccak256 of concatenated hex/ascii parts → 0x-prefixed hex. */
function keccakHex(data: string): `0x${string}` {
  const isHex = data === "" || /^0x[0-9a-f]*$/i.test(data) || /^[0-9a-f]*$/i.test(data);
  const bytes = data === ""
    ? new Uint8Array(0)
    : isHex
      ? hexToBytes(data.replace(/^0x/i, "").length % 2 ? `0${data.replace(/^0x/i, "")}` : data.replace(/^0x/i, ""))
      : new TextEncoder().encode(data);
  return `0x${bytesToHex(keccak_256(bytes))}` as `0x${string}`;
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
  return keccakHex(
    concatHex(prev, toHex32(origin), ownerSigned ? "01" : "00", toHex32(timestamp), instructionHash),
  );
}
