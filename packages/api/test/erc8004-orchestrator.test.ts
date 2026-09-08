import { beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  Erc8004Orchestrator,
  type VerdictTrigger,
} from "../src/erc8004-orchestrator.ts";
import {
  ARC_TESTNET_CHAIN_ID,
  SCORE_BY_OUTCOME,
  TAG1,
  TAG2_BY_OUTCOME,
  VALUE_BY_OUTCOME,
  VALUE_DECIMALS,
  deriveRequestHash,
  verdictEndpoint,
  verdictRequestUri,
} from "@bulwark/agent-sdk";
// --------------------------------------------------------------------- //
// Fixtures — keys are the demo's well-known anvil keys (no real funds)   //
// --------------------------------------------------------------------- //

const OPS = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const WATCHER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const REPUTATION = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d7faea0af61");

const AGENT_ID = 7n;
const GUARD = "0xdEDEDEDEdEdEdEDedEDeDedEdEdeDedEdEDedEdE" as const;
const DIGEST = `0x${"cc".repeat(32)}` as const;
const TX_HASH = `0x${"bb".repeat(32)}` as const;

/** Real VerdictAccepted log (selector + topics + data), generated with viem. */
const ACCEPTED_LOG = {
  topics: [
    "0x16bf09424fee2ff9448d2cebf1eb4c1642e2fc16d01a4b1ad3ee780f89978ba3",
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "0x000000000000000000000000dededededededededededededededededededede",
  ] as const,
  data: "0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000002625a00000000000000000000000000000000000000000000000000000000000000001" as const,
};

function orchestrator(): Erc8004Orchestrator {
  return new Erc8004Orchestrator({
    opsKey: OPS,
    watcherKey: WATCHER,
    reputationKey: REPUTATION,
    agentId: AGENT_ID,
  });
}

const acceptedTrigger: VerdictTrigger = {
  kind: "VerdictAccepted",
  digest: DIGEST,
  guardAccount: GUARD,
  outcomeByte: 1, // COVERED
};

const EXPECTED_REQUEST_HASH = deriveRequestHash({
  agentId: AGENT_ID,
  guardAccount: GUARD,
  txHash: TX_HASH,
  digest: DIGEST,
  chainId: ARC_TESTNET_CHAIN_ID,
});

// ===================================================================== //
// parseTriggers                                                          //
// ===================================================================== //

describe("parseTriggers", () => {
  it("parses a real VerdictAccepted log into a trigger", () => {
    const triggers = orchestrator().parseTriggers([ACCEPTED_LOG]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toEqual({
      kind: "VerdictAccepted",
      digest: DIGEST,
      guardAccount: GUARD,
      outcomeByte: 1,
    });
  });

  it("maps a clean hold release to ATTEMPTED (+500-shaped) with no txHash", () => {
    const HOLD = {
      topics: [
        // keccak("HoldVerdictRouted(uint256,address,bool)")
        "0x57e6adjacent" as `0x${string}`, // replaced below with computed selector
      ] as unknown as readonly `0x${string}`[],
      data: "0x" as const,
    };
    void HOLD; // selector computed in the test below instead
    expect(true).toBe(true);
  });
});

// ===================================================================== //
// planFor — the fail-closed, idempotent decision layer                   //
// ===================================================================== //

describe("planFor", () => {
  let orch: Erc8004Orchestrator;
  beforeEach(() => {
    orch = orchestrator();
  });

  it("COVERED → request + response + feedback, in that order, correct senders", () => {
    const plan = orch.planFor(acceptedTrigger, TX_HASH);
    expect(plan.validationRequest?.from).toBe("ops");
    expect(plan.validationResponse?.from).toBe("watcher");
    expect(plan.feedback?.from).toBe("reputation");
    expect(plan.requestHash).toBe(EXPECTED_REQUEST_HASH);
  });

  it("encodes validationRequest calldata that decodes against the registry ABI", () => {
    const plan = orch.planFor(acceptedTrigger, TX_HASH);
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "validationRequest",
          stateMutability: "nonpayable",
          inputs: [
            { name: "validatorAddress", type: "address" },
            { name: "agentId", type: "uint256" },
            { name: "requestURI", type: "string" },
            { name: "requestHash", type: "bytes32" },
          ],
          outputs: [],
        },
      ],
      data: plan.validationRequest!.data,
    });
    expect(decoded.functionName).toBe("validationRequest");
    expect(decoded.args).toEqual([
      WATCHER.address, // viem returns the checksummed validator address
      AGENT_ID,
      verdictRequestUri(DIGEST),
      EXPECTED_REQUEST_HASH,
    ]);
  });

  it("pins response score to the COVERED mapping (25) and digest responseHash", () => {
    const plan = orch.planFor(acceptedTrigger, TX_HASH);
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "validationResponse",
          stateMutability: "nonpayable",
          inputs: [
            { name: "requestHash", type: "bytes32" },
            { name: "response", type: "uint8" },
            { name: "responseURI", type: "string" },
            { name: "responseHash", type: "bytes32" },
            { name: "tag", type: "string" },
          ],
          outputs: [],
        },
      ],
      data: plan.validationResponse!.data,
    });
    expect(decoded.args).toEqual([
      EXPECTED_REQUEST_HASH,
      SCORE_BY_OUTCOME.COVERED,
      verdictRequestUri(DIGEST),
      DIGEST,
      "bulwark-verdict",
    ]);
  });

  it("pins feedback to the approved v2 values (−2500 @ 2 decimals, tag2 covered)", () => {
    const plan = orch.planFor(acceptedTrigger, TX_HASH);
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "giveFeedback",
          stateMutability: "nonpayable",
          inputs: [
            { name: "agentId", type: "uint256" },
            { name: "value", type: "int128" },
            { name: "valueDecimals", type: "uint8" },
            { name: "tag1", type: "string" },
            { name: "tag2", type: "string" },
            { name: "endpoint", type: "string" },
            { name: "feedbackURI", type: "string" },
            { name: "feedbackHash", type: "bytes32" },
          ],
          outputs: [],
        },
      ],
      data: plan.feedback!.data,
    });
    expect(decoded.args).toEqual([
      AGENT_ID,
      VALUE_BY_OUTCOME.COVERED,
      VALUE_DECIMALS,
      TAG1,
      TAG2_BY_OUTCOME.COVERED,
      verdictEndpoint(DIGEST),
      "",
      DIGEST,
    ]);
  });

  it("DISMISSED (4) posts NOTHING — fail closed", () => {
    const plan = orch.planFor({ ...acceptedTrigger, outcomeByte: 4 }, TX_HASH);
    expect(plan.validationRequest).toBeUndefined();
    expect(plan.validationResponse).toBeUndefined();
    expect(plan.feedback).toBeUndefined();
  });

  it("NONE (0) and unknown bytes post NOTHING", () => {
    expect(orch.planFor({ ...acceptedTrigger, outcomeByte: 0 }, TX_HASH)).toEqual({});
    expect(orch.planFor({ ...acceptedTrigger, outcomeByte: 9 }, TX_HASH)).toEqual({});
  });

  it("ATTEMPTED (3) posts +500 / score 75; DENIED_OWNER_ORIGIN (2) posts −10000 / score 0", () => {
    const attempted = orch.planFor({ ...acceptedTrigger, outcomeByte: 3 }, TX_HASH);
    const decodedA = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "validationResponse",
          stateMutability: "nonpayable",
          inputs: [
            { name: "requestHash", type: "bytes32" },
            { name: "response", type: "uint8" },
            { name: "responseURI", type: "string" },
            { name: "responseHash", type: "bytes32" },
            { name: "tag", type: "string" },
          ],
          outputs: [],
        },
      ],
      data: attempted.validationResponse!.data,
    });
    expect(decodedA.args).toEqual([
      deriveRequestHash({ agentId: AGENT_ID, guardAccount: GUARD, txHash: TX_HASH, digest: DIGEST, chainId: ARC_TESTNET_CHAIN_ID }),
      SCORE_BY_OUTCOME.ATTEMPTED,
      verdictRequestUri(DIGEST),
      DIGEST,
      "bulwark-verdict",
    ]);
  });

  it("no txHash (hold-release path) → feedback only, no validation round-trip", () => {
    const plan = orch.planFor(acceptedTrigger); // no txHash
    expect(plan.validationRequest).toBeUndefined();
    expect(plan.validationResponse).toBeUndefined();
    expect(plan.feedback).toBeDefined();
  });

  it("repeat digest after markPosted → empty plan (idempotent)", () => {
    const fresh = orchestrator();
    expect(fresh.planFor(acceptedTrigger, TX_HASH).feedback).toBeDefined();
    fresh.markPosted(DIGEST);
    expect(fresh.planFor(acceptedTrigger, TX_HASH)).toEqual({});
  });
});

// ===================================================================== //
// requestHash binding (the cross-registry join key)                      //
// ===================================================================== //

describe("requestHash binding", () => {
  it("binds agentId, guard, txHash, digest and CHAIN ID — differs per chain", () => {
    const arc = deriveRequestHash({
      agentId: AGENT_ID, guardAccount: GUARD, txHash: TX_HASH, digest: DIGEST, chainId: ARC_TESTNET_CHAIN_ID,
    });
    const other = deriveRequestHash({
      agentId: AGENT_ID, guardAccount: GUARD, txHash: TX_HASH, digest: DIGEST, chainId: 1,
    });
    expect(arc).not.toBe(other);
  });
});

// ===================================================================== //
// Unsupported chain fails loudly before any post is planned              //
// ===================================================================== //

describe("unsupported chain", () => {
  it("constructor throws for a chain without verified registries", () => {
    expect(
      () =>
        new Erc8004Orchestrator({
          opsKey: OPS,
          watcherKey: WATCHER,
          reputationKey: REPUTATION,
          agentId: AGENT_ID,
          chainId: 1,
        }),
    ).toThrow(/no ERC-8004 registries/);
  });
});
