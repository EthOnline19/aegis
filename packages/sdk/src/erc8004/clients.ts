/**
 * Network clients for the three ERC-8004 registries.
 *
 * Key custody: NONE. Every write goes through the caller-injected
 * `submit` callback (the orchestrator's signed wallet; the SDK itself
 * never holds keys or moves funds — plan §31, and the doc header in
 * src/index.ts). Reads go straight through viem's PublicClient.
 *
 * Clients are thin on purpose: encoding lives in encoding.ts/mapping.ts,
 * addresses in addresses.ts, so unit tests can pin every byte without a
 * network and the orchestrator can compose flows without re-deriving.
 */
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type PublicClient } from "viem";

import type { FeedbackEntry, VerdictOutcome } from "./types.ts";
import { TAG2_BY_OUTCOME, VALUE_DECIMALS, verdictEndpoint } from "./mapping.ts";

/** A signed-and-sent write. Returns the tx hash; the caller awaits receipts. */
export type Submit = (to: `0x${string}`, data: `0x${string}`) => Promise<`0x${string}`>;

/** Minimal read surface — `PublicClient` satisfies it. */
export type Reader = Pick<PublicClient, "readContract" | "call">;
/** Client base: one registry address + a reader for view calls. */
abstract class RegistryClient {
  constructor(
    protected readonly address: `0x${string}`,
    protected readonly reader: Reader,
    protected readonly abi: Abi,
  ) {}

  /** Encode a call for `submit` (write path) — no network. */
  protected encode(functionName: string, args: readonly unknown[]): `0x${string}` {
    return encodeFunctionData({ abi: this.abi, functionName, args }) as `0x${string}`;
  }

  /**
   * Execute a read against the registry. A reverted call (e.g.
   * getValidationStatus "unknown") decodes to nothing, so the revert is
   * surfaced as an Error — callers catch it to detect one-time writes.
   */
  protected async read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    const data = this.encode(functionName, args);
    const result = await this.reader.call({ to: this.address, data });
    return decodeFunctionResult({
      abi: this.abi,
      functionName,
      data: result.data ?? "0x",
    }) as T;
  }
}

// --------------------------------------------------------------------- //
//                            Identity                                   //
// --------------------------------------------------------------------- //

export interface IdentityReads {
  ownerOf(agentId: bigint): Promise<`0x${string}`>;
  getAgentWallet(agentId: bigint): Promise<`0x${string}`>;
  isAuthorizedOrOwner(spender: `0x${string}`, agentId: bigint): Promise<boolean>;
}

export class IdentityClient extends RegistryClient implements IdentityReads {
  async ownerOf(agentId: bigint): Promise<`0x${string}`> {
    return this.read<[Address]>("ownerOf", [agentId]).then(([owner]) => owner);
  }

  async getAgentWallet(agentId: bigint): Promise<`0x${string}`> {
    return this.read<[Address]>("getAgentWallet", [agentId]).then(([wallet]) => wallet);
  }

  async isAuthorizedOrOwner(spender: `0x${string}`, agentId: bigint): Promise<boolean> {
    return this.read<[boolean]>("isAuthorizedOrOwner", [spender, agentId]).then(([ok]) => ok);
  }

  /** `register(agentURI)` calldata — caller signs with the ops key. */
  registerData(agentURI: string): `0x${string}` {
    return this.encode("register", [agentURI]);
  }

  /**
   * `setAgentWallet(agentId, newWallet, deadline, signature)` calldata.
   * `signature` is the EIP-712 `AgentWalletSet` signature FROM `newWallet`
   * over the registry's domain — produced by the wallet holder (guard
   * account), relayed here by the ops key.
   */
  setAgentWalletData(inputs: {
    readonly agentId: bigint;
    readonly newWallet: `0x${string}`;
    readonly deadline: bigint;
    readonly signature: `0x${string}`;
  }): `0x${string}` {
    return this.encode("setAgentWallet", [
      inputs.agentId,
      inputs.newWallet,
      inputs.deadline,
      inputs.signature,
    ]);
  }
}

// --------------------------------------------------------------------- //
//                            Validation                                //
// --------------------------------------------------------------------- //

export interface ValidationStatusResult {
  readonly validatorAddress: `0x${string}`;
  readonly agentId: bigint;
  readonly response: number;
  readonly responseHash: `0x${string}`;
  readonly tag: string;
  readonly lastUpdate: bigint;
}

export class ValidationClient extends RegistryClient {
  /** `validationRequest(...)` calldata — signed by the ops key (NFT owner). */
  validationRequestData(inputs: {
    readonly validatorAddress: `0x${string}`;
    readonly agentId: bigint;
    readonly requestURI: string;
    readonly requestHash: `0x${string}`;
  }): `0x${string}` {
    return this.encode("validationRequest", [
      inputs.validatorAddress,
      inputs.agentId,
      inputs.requestURI,
      inputs.requestHash,
    ]);
  }

  /** `validationResponse(...)` calldata — signed by the WATCHER key only. */
  validationResponseData(inputs: {
    readonly requestHash: `0x${string}`;
    readonly score: number;
    readonly responseURI: string;
    readonly responseHash: `0x${string}`;
    readonly tag: string;
  }): `0x${string}` {
    return this.encode("validationResponse", [
      inputs.requestHash,
      inputs.score,
      inputs.responseURI,
      inputs.responseHash,
      inputs.tag,
    ]);
  }

  /**
   * Idempotency gate (design §2): writes are one-time — a requestHash
   * already registered throws here ("unknown" from the registry), so the
   * orchestrator skips instead of double-posting.
   */
  async getValidationStatus(requestHash: `0x${string}`): Promise<ValidationStatusResult | undefined> {
    try {
      const [validatorAddress, agentId, response, responseHash, tag, lastUpdate] =
        await this.read<[Address, bigint, number, `0x${string}`, string, bigint]>("getValidationStatus", [requestHash]);
      return { validatorAddress, agentId, response, responseHash, tag, lastUpdate };
    } catch {
      return undefined; // registry reverts "unknown" for unregistered hashes
    }
  }
}

// --------------------------------------------------------------------- //
//                            Reputation                                //
// --------------------------------------------------------------------- //

export class ReputationClient extends RegistryClient {
  /**
   * `giveFeedback(...)` calldata for a verdict outcome — signed by the
   * REPUTATION key (neither NFT owner nor operator, else the registry's
   * self-feedback guard reverts).
   */
  giveFeedbackData(inputs: {
    readonly agentId: bigint;
    readonly outcome: VerdictOutcome;
    readonly value: bigint;
    readonly digest: `0x${string}`;
  }): `0x${string}` {
    return this.encode("giveFeedback", [
      inputs.agentId,
      inputs.value, // viem encodes signed bigints to two's complement
      VALUE_DECIMALS,
      "bulwark-verdict",
      TAG2_BY_OUTCOME[inputs.outcome],
      verdictEndpoint(inputs.digest),
      "", // feedbackURI — the endpoint carries the machine link
      inputs.digest, // feedbackHash = verdict digest
    ]);
  }

  /** One entry; index 0 / out-of-bounds reverts upstream. */
  async readFeedback(agentId: bigint, client: `0x${string}`, feedbackIndex: bigint): Promise<FeedbackEntry> {
    const [value, valueDecimals, tag1, tag2, isRevoked] = await this.read<
      [bigint, number, string, string, boolean]
    >("readFeedback", [agentId, client, feedbackIndex]);
    return { client, feedbackIndex, value, valueDecimals, tag1, tag2, isRevoked };
  }
}
