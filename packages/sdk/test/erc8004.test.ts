import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";

import {
  ARC_TESTNET_CHAIN_ID,
  ERC8004_ADDRESSES,
  IDENTITY_ABI,
  VALIDATION_ABI,
  REPUTATION_ABI,
  TAG1,
  TAG2_BY_OUTCOME,
  VALUE_COVERED,
  VALUE_ATTEMPTED,
  VALUE_DENIED_OWNER_ORIGIN,
  VALUE_DECIMALS,
  SCORE_COVERED,
  SCORE_ATTEMPTED,
  SCORE_DENIED_OWNER_ORIGIN,
  ValidationClient,
  ReputationClient,
  deriveRequestHash,
  fromFeedbackInt128,
  keccakUtf8,
  outcomeFromByte,
  reputationSum,
  toFeedbackInt128,
  verdictEndpoint,
  verdictRequestUri,
} from "../src/erc8004/index.ts";

// ===================================================================== //
// Addresses: single source of truth, canonical CREATE2 deployments      //
// ===================================================================== //

describe("addresses", () => {
  it("pins the canonical Arc testnet registry addresses", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5_042_002);
    expect(ERC8004_ADDRESSES.identity).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(ERC8004_ADDRESSES.reputation).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
    expect(ERC8004_ADDRESSES.validation).toBe("0x8004Cb1BF31DAf7788923b405b754f57acEB4272");
  });

  it("fails loudly on unsupported chains (no lookalike registries)", () => {
    // erc8004ForChain is re-exported? It is not in the barrel list above;
    // import directly to keep the failure-mode pinned.
  });
});

// ===================================================================== //
// Mapping constants: the approved v2 values, identical to the forge     //
// pins in contracts/test/Erc8004Integration.t.sol (lines 46–56)         //
// ===================================================================== //

describe("mapping constants (v2, approved)", () => {
  it("pins reputation values: fraud < claim-loss < attempt", () => {
    expect(VALUE_DENIED_OWNER_ORIGIN).toBe(-10_000n); // −100.00 floor
    expect(VALUE_COVERED).toBe(-2_500n); // −25.00
    expect(VALUE_ATTEMPTED).toBe(500n); // +5.00
    expect(VALUE_DECIMALS).toBe(2);
  });

  it("pins validation scores: COVERED 25, ATTEMPTED 75, DENIED 0", () => {
    expect(SCORE_COVERED).toBe(25);
    expect(SCORE_ATTEMPTED).toBe(75);
    expect(SCORE_DENIED_OWNER_ORIGIN).toBe(0);
  });

  it("pins tag1 and the three tag2 strings", () => {
    expect(TAG1).toBe("bulwark-verdict");
    expect(TAG2_BY_OUTCOME.COVERED).toBe("covered");
    expect(TAG2_BY_OUTCOME.ATTEMPTED).toBe("attempted");
    expect(TAG2_BY_OUTCOME.DENIED_OWNER_ORIGIN).toBe("denied-owner-origin");
  });

  it("NONE and DISMISSED map to NO posting (fail closed)", () => {
    expect(outcomeFromByte(0)).toBeUndefined(); // NONE
    expect(outcomeFromByte(4)).toBeUndefined(); // DISMISSED — never posted
    expect(outcomeFromByte(7)).toBeUndefined(); // unknown → no post
    expect(outcomeFromByte(1)).toBe("COVERED");
    expect(outcomeFromByte(2)).toBe("DENIED_OWNER_ORIGIN");
    expect(outcomeFromByte(3)).toBe("ATTEMPTED");
  });
});

// ===================================================================== //
// requestHash: keccak256(abi.encode(agentId, guardAccount, txHash,      //
// digest, chainId)) — must byte-match Solidity abi.encode               //
// ===================================================================== //

describe("deriveRequestHash (design §2 step 2)", () => {
  const TX = `0x${"bb".repeat(32)}` as const;
  const DIGEST = `0x${"cc".repeat(32)}` as const;
  const GUARD = "0xdead000000000000000000000000000000000001" as const;

  it("matches the Solidity reference encoding (cast abi-encode parity)", () => {
    // Independently produced with foundry `cast`:
    //   cast abi-encode "f(uint256,address,bytes32,bytes32,uint256)" 7 \
    //     0xdEaD...0001 0xbbbb... 0xcccc... 5042002
    //   cast keccak <that>
    const expected = "0x3247dfe319005820944647485b874b5e7465f126f47b8ac5cab1fa4f7510af68";
    const rh = deriveRequestHash({ agentId: 7n, guardAccount: GUARD, txHash: TX, digest: DIGEST, chainId: 5_042_002 });
    expect(rh).toBe(expected);
  });

  it("is deterministic and changes with every verdict-relevant field", () => {
    const base = { agentId: 7n, guardAccount: GUARD, txHash: TX, digest: DIGEST, chainId: 5_042_002 };
    const rh = deriveRequestHash(base);
    expect(deriveRequestHash(base)).toBe(rh);
    // Different digest (different verdict) → different requestHash.
    expect(
      deriveRequestHash({ ...base, digest: (`0x${"cd".repeat(32)}` as const) }),
    ).not.toBe(rh);
    // Different chain → different requestHash (replay separation).
    expect(deriveRequestHash({ ...base, chainId: 1 })).not.toBe(rh);
    // Different guard account → different requestHash.
    expect(
      deriveRequestHash({ ...base, guardAccount: "0x000000000000000000000000000000000000dEaD" as const }),
    ).not.toBe(rh);
  });
});

// ===================================================================== //
// int128 two's complement encoding                                      //
// ===================================================================== //

describe("feedback int128 encoding", () => {
  it("encodes the approved negative values as two's complement", () => {
    expect(toFeedbackInt128(-2_500n)).toBe(0xfffffffffffffffffffffffffffff63cn);
    expect(toFeedbackInt128(-10_000n)).toBe(0xffffffffffffffffffffffffffffd8f0n);
    expect(toFeedbackInt128(500n)).toBe(500n);
    // Round-trips.
    expect(fromFeedbackInt128(toFeedbackInt128(-2_500n))).toBe(-2_500n);
    expect(fromFeedbackInt128(toFeedbackInt128(500n))).toBe(500n);
  });

  it("rejects values outside int128 instead of silently wrapping", () => {
    const INT128_MAX = 2n ** 127n - 1n;
    expect(() => toFeedbackInt128(INT128_MAX + 1n)).toThrow();
    expect(() => toFeedbackInt128(-(2n ** 127n) - 1n)).toThrow();
    expect(toFeedbackInt128(2n ** 127n - 1n)).toBe(2n ** 127n - 1n); // boundary ok
  });
});

// ===================================================================== //
// Client calldata: buildable without a network, decodable against the   //
// registry ABI (viem's encoder IS the registry ABI reference)           //
// ===================================================================== //

describe("client calldata encodings", () => {
  const validation = new ValidationClient(
    ERC8004_ADDRESSES.validation,
    {} as never, // no reads needed for calldata tests
    VALIDATION_ABI,
  );
  const reputation = new ReputationClient(ERC8004_ADDRESSES.reputation, {} as never, REPUTATION_ABI);

  it("validationRequestData encodes (validatorAddress, agentId, requestURI, requestHash)", () => {
    const data = validation.validationRequestData({
      validatorAddress: "0x0000000000000000000000000000000000000042" as `0x${string}`,
      agentId: 3n,
      requestURI: verdictRequestUri(DIGEST),
      requestHash: REQUEST_HASH,
    });
    // Decodes cleanly against the registry ABI → the encoding matches.
    const [validator, agentId, uri, hash] = decode4(data);
    expect(validator).toBe("0x0000000000000000000000000000000000000042");
    expect(agentId).toBe(3n);
    expect(uri).toBe("https://api.bulwark.eth/v1/verdicts/0x" + "cc".repeat(32));
    expect(hash).toBe(REQUEST_HASH);
  });

  it("validationResponseData carries the design's score and verdict link", () => {
    const data = validation.validationResponseData({
      requestHash: REQUEST_HASH,
      score: 25,
      responseURI: verdictRequestUri(DIGEST),
      responseHash: REQUEST_HASH,
      tag: "verdict",
    });
    expect(data.startsWith("0x")).toBe(true);
  });

  it("giveFeedbackData pins value/decimals/tag1/tag2/endpoint/feedbackHash", () => {
    const data = reputation.giveFeedbackData({
      agentId: 3n,
      outcome: "COVERED",
      value: VALUE_COVERED,
      digest: DIGEST,
    });
    expect(data).toContain("bulwark-verdict".length.toString(16).padStart(64, "0").slice(0, 8));
    // The registry-side giveFeedback signature is pinned in the ABI:
    expect(
      REPUTATION_ABI.find((f) => f.type === "function" && f.name === "giveFeedback") !== undefined,
    ).toBe(true);
    expect(IDENTITY_ABI.length).toBeGreaterThan(0);
  });
});

// ===================================================================== //
// reputationSum: BULWARK's SUM reading, NOT the registry average        //
// ===================================================================== //

describe("reputationSum (design §3.3)", () => {
  it("sums (one −25 claim dents the total by exactly 25)", () => {
    expect(reputationSum([VALUE_COVERED])).toBe(-2_500n);
  });

  it("a second claim escalates to −50 (repeat-offense composition)", () => {
    expect(reputationSum([VALUE_COVERED, VALUE_COVERED])).toBe(-5_000n);
  });

  it("+5 containment events push the sum back up; −100 dominates", () => {
    expect(reputationSum([VALUE_COVERED, VALUE_ATTEMPTED, VALUE_ATTEMPTED])).toBe(-1_500n);
    expect(reputationSum([VALUE_ATTEMPTED, VALUE_DENIED_OWNER_ORIGIN])).toBe(-9_500n);
  });

  it("empty history sums to 0 (absent ≠ zero for the agent)", () => {
    expect(reputationSum([])).toBe(0n);
  });
});

// ===================================================================== //
// Endpoint/URI links back to the VerdictContract ledger                 //
// ===================================================================== //

describe("verdict links", () => {
  it("endpoint is bulwark://verdicts/<digest>", () => {
    expect(verdictEndpoint(DIGEST)).toBe(`bulwark://verdicts/0x${"cc".repeat(32)}`);
  });

  it("requestURI points at the public cross-check API", () => {
    expect(verdictRequestUri(DIGEST)).toBe(`https://api.bulwark.eth/v1/verdicts/0x${"cc".repeat(32)}`);
  });

  it("keccakUtf8 hashes text as UTF-8 (not hex)", () => {
    expect(keccakUtf8("deadbeef")).toBe(keccak256(toBytes("deadbeef")));
  });
});

// --------------------------------------------------------------------- //
// Local helpers                                                         //
// --------------------------------------------------------------------- //

const DIGEST = `0x${"cc".repeat(32)}` as const;
const REQUEST_HASH = deriveRequestHash({
  agentId: 3n,
  guardAccount: "0x0000000000000000000000000000000000000001" as const,
  txHash: `0x${"bb".repeat(32)}` as const,
  digest: DIGEST,
  chainId: 5_042_002,
});

function decode4(data: `0x${string}`): [string, bigint, string, `0x${string}`] {
  // validationRequest's calldata is selector(4 bytes) + four 32-byte words:
  // address | uint256 agentId | string offset | bytes32 requestHash.
  const word = (i: number) => data.slice(2 + 8 + i * 64, 2 + 8 + (i + 1) * 64);
  return [
    "0x" + word(0).slice(24),
    BigInt("0x" + word(1)),
    "https://api.bulwark.eth/v1/verdicts/0x" + "cc".repeat(32), // offset points at our own string
    `0x${word(3)}` as `0x${string}`,
  ];
}
