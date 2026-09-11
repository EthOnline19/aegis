// REPAYD ERC-8004 Standard Registries Subgraph — mappings.
//
// Pure event→entity projections of the CANONICAL ERC-8004 registry events
// (EIP-8004 spec shapes — not REPAYD-internal events). Three registries,
// one agent namespace: Erc8004Agent keyed by agentId, enriched by
// reputation (feedback) and validation (request/response) activity.
//
// Composition note: REPAYD's orchestrator mirrors each accepted verdict
// into the standard registries (design: docs/ERC8004_DESIGN.md) —
// giveFeedback value −2500@2dp tag2 "covered" and a validation whose
// responseHash IS the verdict digest. This subgraph is the standard-schema
// mirror that the Risk Subgraph's bespoke Verdict/Claim entities join on.

import {
  Erc8004Agent,
  Erc8004Feedback,
  Erc8004Validation,
} from "../generated/schema";
import {
  Registered,
  URIUpdated,
  MetadataSet,
} from "../generated/Erc8004Identity/Erc8004Identity";
import {
  NewFeedback,
  FeedbackRevoked,
} from "../generated/Erc8004Reputation/Erc8004Reputation";
import {
  ValidationRequest,
  ValidationResponse,
} from "../generated/Erc8004Validation/Erc8004Validation";
import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

const AGENT_WALLET_KEY = "agentWallet";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function agentId(id: BigInt): string {
  return id.toString();
}

/** Load-or-create the agent; feedback/validation handlers may see an
 *  agent that Registered before our startBlock (never on Arc — startBlocks
 *  are the exact first-code blocks — but be robust anyway). */
function loadAgent(id: BigInt, timestamp: BigInt): Erc8004Agent {
  let agent = Erc8004Agent.load(agentId(id));
  if (agent === null) {
    agent = new Erc8004Agent(agentId(id));
    agent.owner = Bytes.fromHexString(ZERO_ADDRESS);
    agent.agentURI = "";
    agent.wallet = Bytes.fromHexString(ZERO_ADDRESS);
    agent.registeredAt = timestamp;
    agent.lastActivityAt = timestamp;
  }
  return agent as Erc8004Agent;
}

function touch(agent: Erc8004Agent, timestamp: BigInt): void {
  agent.lastActivityAt = timestamp;
  agent.save();
}

/** Metadata value is bytes: first 20 bytes = agentWallet address.
 *  An empty/short value means "cleared" (transfer hook). */
function walletFromMetadataValue(value: Bytes): Bytes {
  if (value.length >= 20) {
    const out = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      out[i] = value[i];
    }
    return Bytes.fromUint8Array(out);
  }
  return Bytes.fromHexString(ZERO_ADDRESS);
}

// ------------------------------------------------------------------ //
//                     IdentityRegistry                               //
// ------------------------------------------------------------------ //

export function handleRegistered(event: Registered): void {
  const agent = new Erc8004Agent(agentId(event.params.agentId));
  agent.owner = event.params.owner;
  agent.agentURI = event.params.agentURI;
  // register() writes the caller as the initial agentWallet (spec §identity);
  // the follow-up MetadataSet("agentWallet") event pins it explicitly.
  agent.wallet = event.params.owner;
  agent.registeredAt = event.block.timestamp;
  agent.lastActivityAt = event.block.timestamp;
  agent.save();
}

export function handleUriUpdated(event: URIUpdated): void {
  const agent = Erc8004Agent.load(agentId(event.params.agentId));
  if (agent !== null) {
    agent.agentURI = event.params.newURI;
    touch(agent as Erc8004Agent, event.block.timestamp);
  }
}

export function handleMetadataSet(event: MetadataSet): void {
  // The reserved "agentWallet" key is the only one we project; other
  // metadata keys are free-form (public keys, capability flags) and stay
  // in the event log for consumers that want them.
  if (event.params.metadataKey != AGENT_WALLET_KEY) {
    return;
  }
  const agent = Erc8004Agent.load(agentId(event.params.agentId));
  if (agent !== null) {
    (agent as Erc8004Agent).wallet = walletFromMetadataValue(
      event.params.metadataValue,
    );
    touch(agent as Erc8004Agent, event.block.timestamp);
  }
}

// ------------------------------------------------------------------ //
//                     ReputationRegistry                             //
// ------------------------------------------------------------------ //

export function handleNewFeedback(event: NewFeedback): void {
  const agent = loadAgent(event.params.agentId, event.block.timestamp);
  agent.save();

  const feedback = new Erc8004Feedback(
    agentId(event.params.agentId) +
      "-" +
      event.params.clientAddress.toHexString() +
      "-" +
      event.params.feedbackIndex.toString(),
  );
  feedback.agent = agent.id;
  feedback.client = event.params.clientAddress;
  feedback.feedbackIndex = event.params.feedbackIndex;
  feedback.value = event.params.value;
  feedback.valueDecimals = event.params.valueDecimals;
  feedback.tag1 = event.params.tag1;
  feedback.tag2 = event.params.tag2;
  feedback.endpoint = event.params.endpoint;
  feedback.feedbackURI = event.params.feedbackURI;
  feedback.feedbackHash = event.params.feedbackHash;
  feedback.isRevoked = false;
  feedback.blockTimestamp = event.block.timestamp;
  feedback.save();

  touch(agent, event.block.timestamp);
}

export function handleFeedbackRevoked(event: FeedbackRevoked): void {
  const id =
    agentId(event.params.agentId) +
    "-" +
    event.params.clientAddress.toHexString() +
    "-" +
    event.params.feedbackIndex.toString();
  const feedback = Erc8004Feedback.load(id);
  if (feedback !== null) {
    const fb = feedback as Erc8004Feedback;
    fb.isRevoked = true;
    fb.revokedAt = event.block.timestamp;
    fb.save();
    const agent = Erc8004Agent.load(fb.agent);
    if (agent !== null) {
      touch(agent as Erc8004Agent, event.block.timestamp);
    }
  }
}

// ------------------------------------------------------------------ //
//                     ValidationRegistry                             //
// ------------------------------------------------------------------ //

export function handleValidationRequest(event: ValidationRequest): void {
  const agent = loadAgent(event.params.agentId, event.block.timestamp);
  agent.save();

  const validation = new Erc8004Validation(
    event.params.requestHash.toHexString(),
  );
  validation.agent = agent.id;
  validation.validator = event.params.validatorAddress;
  validation.requestURI = event.params.requestURI;
  // response stays null until the named validator answers (schema:
  // response: Int is nullable; 0..100 per EIP-8004 §validation);
  // responseHash is non-nullable → zero-bytes32 until the response lands.
  validation.responseHash = Bytes.fromHexString(ZERO_BYTES32);
  validation.tag = "";
  validation.requestedAt = event.block.timestamp;
  validation.respondedAt = null;
  validation.blockTimestamp = event.block.timestamp;
  validation.save();

  touch(agent, event.block.timestamp);
}

export function handleValidationResponse(event: ValidationResponse): void {
  const validation = Erc8004Validation.load(
    event.params.requestHash.toHexString(),
  );
  if (validation === null) {
    // Response to a request made before our startBlock — synthesize from
    // the event itself (Arc's first-code startBlocks make this impossible
    // in practice; robustness only).
    const agent = loadAgent(event.params.agentId, event.block.timestamp);
    agent.save();
    const v = new Erc8004Validation(event.params.requestHash.toHexString());
    v.agent = agent.id;
    v.validator = event.params.validatorAddress;
    v.requestURI = "";
    v.requestedAt = event.block.timestamp;
    v.blockTimestamp = event.block.timestamp;
    v.response = event.params.response;
    v.responseURI = event.params.responseURI;
    v.responseHash = event.params.responseHash;
    v.tag = event.params.tag;
    v.respondedAt = event.block.timestamp;
    v.save();
    touch(agent, event.block.timestamp);
    return;
  }
  const v = validation as Erc8004Validation;
  v.response = event.params.response;
  v.responseURI = event.params.responseURI;
  v.responseHash = event.params.responseHash;
  v.tag = event.params.tag;
  v.respondedAt = event.block.timestamp;
  v.save();

  const agent = Erc8004Agent.load(v.agent);
  if (agent !== null) {
    touch(agent as Erc8004Agent, event.block.timestamp);
  }
}

