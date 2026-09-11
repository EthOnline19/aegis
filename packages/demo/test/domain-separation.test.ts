/**
 * EIP-712 domain separation across chains (the H2 class of bug, demo side).
 *
 * protocol.ts previously derived verdict digests with a hardcoded `anvil`
 * chain ID (31337). Against a VerdictContract deployed on any other chain
 * (e.g. Arc 5042002) the on-chain DOMAIN_SEPARATOR embeds THAT chain's id,
 * so every demo-signed verdict failed on-chain ecrecover.
 *
 * The fix threads an explicit `chainId` through domainSeparator /
 * verdictDigest712 / holdVerdictDigest712; the demo resolves it once from
 * DEMO_CHAIN_ID (env, read at module load — set by the runner from the
 * target RPC) instead of hardcoding 31337.
 *
 * These tests pin the contract:
 *   1. digest(chainId=A) ≠ digest(chainId=B) for identical verdict bytes.
 *   2. A signature over an anvil-ID digest is REJECTED by an Arc-ID domain
 *      (recovered signer ≠ watcher) — and vice versa.
 *   3. Same-domain verification succeeds (sanity).
 */
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, toBytes, type Hash, type Hex } from "viem";

import { domainSeparator, verdictDigest712, signRawDigest } from "../src/protocol.ts";

const ANVIL_ID = 31337n;
const ARC_ID = 5042002n;
const CONTRACT = "0x93B336caDA64E528Fbcc13569Dfc21Ec8676FD5B" as const; // Arc verdicts
const WATCHER_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const watcher = privateKeyToAccount(WATCHER_PK);

const baseVerdict = {
  policyHash: ("0x" + "ab".repeat(32)) as Hash,
  agent: "0xB2a6Bb01acCF8c3903490b2DaF6F80F6d819f222" as const,
  claimant: "0x9675b4D20d2ACFE55D00a02D55B9cdb57AEbD482" as const,
  txHash: ("0x" + "cd".repeat(32)) as Hash,
  destination: "0x328809bc894f92807417d2dad6b7c998c1afdac1" as const,
  lossAmount: 150_000_000n,
  payoutAmount: 135_000_000n,
  alibi: 1,
  outcome: 1,
  reasons: [] as ReadonlyArray<{ tag: Hex; provenance: number; detail: string }>,
  timestamp: 1_789_074_800n,
};

/** Recovers the signer the way VerdictContract._recoverSigner does. */
function recover(digest: Hash, sig: Hex): string {
  const parsed = secp256k1.Signature.fromCompact(sig.slice(2, 130)).addRecoveryBit(
    parseInt(sig.slice(130, 132), 16) - 27,
  );
  const pubkey = parsed.recoverPublicKey(toBytes(digest)).toRawBytes(false);
  const addrHex = keccak256(toBytes(`0x${Buffer.from(pubkey.slice(1)).toString("hex")}`));
  return addrHex.slice(-40);
}

describe("EIP-712 chain-ID separation (demo verdict signing)", () => {
  it("different chain IDs produce different digests for identical verdict bytes", () => {
    const anvilDigest = verdictDigest712(CONTRACT, baseVerdict, ANVIL_ID);
    const arcDigest = verdictDigest712(CONTRACT, baseVerdict, ARC_ID);
    expect(anvilDigest).not.toEqual(arcDigest);
  });

  it("domain separator differs per chain ID with all other inputs equal", () => {
    const a = domainSeparator(CONTRACT, ANVIL_ID);
    const b = domainSeparator(CONTRACT, ARC_ID);
    expect(a).not.toEqual(b);
  });

  it("signature over the anvil-ID digest is REJECTED by the Arc-ID domain (and vice versa)", () => {
    // Watcher signs what the demo WOULD have produced when hardcoded to anvil…
    const anvilDigest = verdictDigest712(CONTRACT, baseVerdict, ANVIL_ID);
    const anvilSig = signRawDigest(anvilDigest, WATCHER_PK);
    // …versus what it produces bound to the chain the contract lives on.
    const arcDigest = verdictDigest712(CONTRACT, baseVerdict, ARC_ID);
    const arcSig = signRawDigest(arcDigest, WATCHER_PK);

    const watcherAddr = watcher.address.toLowerCase().slice(2);
    // Cross-verification MUST fail: recovered signer ≠ watcher.
    expect(recover(arcDigest, anvilSig)).not.toBe(watcherAddr);
    expect(recover(anvilDigest, arcSig)).not.toBe(watcherAddr);
    // Sanity: same-domain verification succeeds.
    expect(recover(arcDigest, arcSig)).toBe(watcherAddr);
    expect(recover(anvilDigest, anvilSig)).toBe(watcherAddr);
  });

  it("digests default to the module-resolved DEMO_CHAIN_ID (no explicit arg)", async () => {
    const { DEMO_CHAIN_ID, verdictDigest712: digestWith } = await import("../src/protocol.ts");
    // Default-arg path must equal the explicit DEMO_CHAIN_ID path.
    expect(digestWith(CONTRACT, baseVerdict)).toEqual(
      verdictDigest712(CONTRACT, baseVerdict, BigInt(DEMO_CHAIN_ID)),
    );
  });
});
