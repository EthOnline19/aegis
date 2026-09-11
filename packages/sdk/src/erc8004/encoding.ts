/**
 * Pure ERC-8004 encoding + derivation helpers.
 *
 * These are the load-bearing bytes: `requestHash` binds an ERC-8004
 * validation request to the exact accepted verdict (agentId, guardAccount,
 * txHash, digest, chainId); `toFeedbackInt128`/`fromFeedbackInt128` move
 * between the design's decimal (−25.00) and the registry's int128;
 * `reputationSum` is REPAYD's SUM-based résumé reading (design §3.3) —
 * deliberately NOT the registry's `getSummary` average.
 *
 * Everything here is synchronous and side-effect free, so the forge-test
 * parity checks and the orchestrator can both run it anywhere.
 */
import { encodeAbiParameters, keccak256, toBytes } from "viem";

/** The design's requestHash: binds the request to the exact verdict. */
export function deriveRequestHash(inputs: {
  readonly agentId: bigint;
  readonly guardAccount: `0x${string}`;
  readonly txHash: `0x${string}`;
  readonly digest: `0x${string}`;
  readonly chainId: number;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "agentId", type: "uint256" },
        { name: "guardAccount", type: "address" },
        { name: "txHash", type: "bytes32" },
        { name: "digest", type: "bytes32" },
        { name: "chainId", type: "uint256" },
      ],
      [inputs.agentId, inputs.guardAccount, inputs.txHash, inputs.digest, BigInt(inputs.chainId)],
    ),
  );
}

/**
 * Decimal value (e.g. −2500 = −25.00 at 2 decimals) → int128 two's
 * complement. Range-checked: the registry reverts outside int128, and a
 * silently wrapped value would poison the driving record.
 */
export function toFeedbackInt128(value: bigint): bigint {
  const INT128_MIN = -(2n ** 127n);
  const INT128_MAX = 2n ** 127n - 1n;
  if (value < INT128_MIN || value > INT128_MAX) {
    throw new Error(`feedback value ${value} outside int128 range`);
  }
  if (value >= 0n) return value;
  return value + 2n ** 128n;
}

/** Inverse of `toFeedbackInt128` (reads back the signed value). */
export function fromFeedbackInt128(raw: bigint): bigint {
  return raw >= 2n ** 127n ? raw - 2n ** 128n : raw;
}

/**
 * REPAYD's SUM-based reputation reading (design §3.3):
 * `Σ values` over matching, non-revoked entries — the net trust mass.
 * Distinct from the registry's `getSummary` AVERAGE; both are surfaced
 * so no consumer mistakes one for the other.
 */
export function reputationSum(values: readonly bigint[]): bigint {
  return values.reduce((sum, v) => sum + v, 0n);
}

/** keccak of UTF-8 text (feedbackHash/responseHash stand-ins). */
export function keccakUtf8(text: string): `0x${string}` {
  return keccak256(toBytes(text));
}
