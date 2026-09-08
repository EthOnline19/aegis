/**
 * ERC-8004 orchestrator (design §5, packages/api half).
 *
 * Listens to `VerdictAccepted` / `HoldVerdictRouted` events from the
 * VerdictContract and mirrors every accepted verdict into the three
 * ERC-8004 registries — the composable, on-chain driving record.
 *
 * Architecture, frozen by the approved design (docs/ERC8004_DESIGN.md §0–§3):
 * - All posts come from THREE separate keys, injected as viem accounts:
 *   `opsKey` owns every agentId NFT and files validationRequest;
 *   `watcherKey` (VerdictContract's watcher, the TEE job key) is the only
 *   address allowed to answer with validationResponse;
 *   `reputationKey` (neither owner nor operator — else the registry's
 *   self-feedback guard reverts) posts giveFeedback.
 * - requestHash binds each ERC-8004 request to the exact verdict
 *   (agentId, guardAccount, txHash, digest, chainId) — see
 *   @bulwark/agent-sdk's erc8004 module.
 * - Writes are one-time; the orchestrator is idempotent per digest: it
 *   skips the validation round-trip when the requestHash already exists.
 * - DISMISSED / unknown outcomes post NOTHING (fail closed).
 * - Posting is not atomic across three transactions; VerdictContract's
 *   own event ledger stays the tamper-evident source of truth — these
 *   registry entries are the composable mirror of it.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEventLogs,
  keccak256,
  toBytes,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

import {
  ARC_TESTNET_CHAIN_ID,
  REPUTATION_ABI,
  SCORE_BY_OUTCOME,
  TAG1,
  TAG2_BY_OUTCOME,
  VALIDATION_ABI,
  VALUE_BY_OUTCOME,
  VALUE_DECIMALS,
  ValidationClient,
  deriveRequestHash,
  erc8004ForChain,
  outcomeFromByte,
  verdictEndpoint,
  verdictRequestUri,
  type VerdictOutcome,
  type Erc8004Registries,
} from "@bulwark/agent-sdk";

/** VerdictContract events this orchestrator reacts to (VerdictContract.sol). */
export const VERDICT_ACCEPTED_EVENT = {
  type: "event",
  name: "VerdictAccepted",
  inputs: [
    { name: "digest", type: "bytes32", indexed: true },
    { name: "agent", type: "address", indexed: true },
    { name: "outcome", type: "uint8", indexed: false },
    { name: "payout", type: "uint96", indexed: false },
    { name: "alibi", type: "uint8", indexed: false },
  ],
} as const;

export const HOLD_VERDICT_ROUTED_EVENT = {
  type: "event",
  name: "HoldVerdictRouted",
  inputs: [
    { name: "holdId", type: "uint256", indexed: true },
    { name: "agent", type: "address", indexed: true },
    { name: "clean", type: "bool", indexed: false },
  ],
} as const;

/** One parsed trigger event, normalized for posting. */
export interface VerdictTrigger {
  readonly kind: "VerdictAccepted" | "HoldVerdictRouted";
  /** bytes32 verdict digest (HoldVerdictRouted carries holdId instead). */
  readonly digest: `0x${string}`;
  /** GuardAccount the verdict concerns. */
  readonly guardAccount: `0x${string}`;
  /** Raw outcome byte; HoldVerdictRouted has none (clean flag decides). */
  readonly outcomeByte?: number;
  /** Breached tx hash — unavailable on HoldVerdictRouted in v1. */
  readonly txHash?: `0x${string}`;
}

/** One registry write, with the key that must sign it. */
export interface PostStep {
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly from: "ops" | "watcher" | "reputation";
}

/** The three-post flow the orchestrator performs per accepted verdict. */
export interface OrchestrationPlan {
  requestHash?: `0x${string}`;
  validationRequest?: PostStep;
  validationResponse?: PostStep;
  feedback?: PostStep;
}

export interface OrchestratorConfig {
  /** The agentId NFTs' owner (BULWARK ops). */
  readonly opsKey: Account;
  /** VerdictContract's watcher — the only allowed responder. */
  readonly watcherKey: Account;
  /** Separate feedback EOA; must NOT own or be approved for agentIds. */
  readonly reputationKey: Account;
  /** agentId minted for this covered agent (ops-owned NFT). */
  readonly agentId: bigint;
  readonly chainId?: number;
  /** RPC endpoint; defaults to localhost (tests/demo). */
  readonly rpcUrl?: string;
}

/**
 * Pure decision layer + thin sending shell. `planFor` builds the exact
 * calldata per accepted verdict; `handle` signs and sends with the right
 * key. Fully unit-testable without a chain: assert on planFor output.
 */
export class Erc8004Orchestrator {
  private readonly chainId: number;
  private readonly registries: Erc8004Registries;
  /** digests already mirrored (in-process idempotency) */
  private readonly posted = new Set<string>();
  private readonly validations: ValidationClient | undefined;

  constructor(private readonly config: OrchestratorConfig) {
    this.chainId = config.chainId ?? ARC_TESTNET_CHAIN_ID;
    this.registries = erc8004ForChain(this.chainId);
    if (config.rpcUrl !== undefined) {
      const reader = createPublicClient({ transport: http(config.rpcUrl) });
      this.validations = new ValidationClient(this.registries.validation as `0x${string}`, reader, VALIDATION_ABI);
    }
  }

  /** Parse raw VerdictContract logs into triggers. */
  parseTriggers(
    logs: readonly { topics: readonly `0x${string}`[]; data: `0x${string}` }[],
  ): VerdictTrigger[] {
    const parsed = parseEventLogs({ abi: [VERDICT_ACCEPTED_EVENT, HOLD_VERDICT_ROUTED_EVENT], logs: logs as never });
    return parsed.flatMap((log): VerdictTrigger[] => {
      if (log.eventName === "VerdictAccepted") {
        const { digest, agent, outcome } = log.args as unknown as {
          digest: `0x${string}`;
          agent: `0x${string}`;
          outcome: number;
        };
        return [{ kind: "VerdictAccepted", digest, guardAccount: agent, outcomeByte: outcome }];
      }
      if (log.eventName === "HoldVerdictRouted") {
        const { holdId, agent, clean } = log.args as unknown as {
          holdId: bigint;
          agent: `0x${string}`;
          clean: boolean;
        };
        // v1: hold releases are ATTEMPTED-shaped (+500, score 75) — the
        // agent was vindicated but attempted something. Frozen-suspicious
        // holds post NOTHING (fail closed). No txHash on hold events, so
        // only the reputation mirror fires.
        return clean
          ? [{ kind: "HoldVerdictRouted", digest: keccak256(toBytes(`hold:${holdId}`)), guardAccount: agent, outcomeByte: 3 }]
          : [];
      }
      return [];
    });
  }

  /**
   * Build the post plan for a trigger WITHOUT sending anything:
   * - unknown/absent outcome → empty plan (fail closed, DISMISSED included);
   * - already-posted digest → empty plan (idempotent);
   * - txHash present → validationRequest (ops) + validationResponse
   *   (watcher) + feedback (reputation), in that order;
   * - txHash missing (hold events) → feedback only.
   */
  planFor(trigger: VerdictTrigger, txHash?: `0x${string}`): OrchestrationPlan {
    const outcome: VerdictOutcome | undefined =
      trigger.outcomeByte === undefined ? undefined : outcomeFromByte(trigger.outcomeByte);
    if (!outcome) return {}; // NONE / DISMISSED / unknown → no post
    if (this.posted.has(trigger.digest)) return {}; // idempotent

    const requestHash = deriveRequestHash({
      agentId: this.config.agentId,
      guardAccount: trigger.guardAccount,
      txHash: (trigger.txHash ?? txHash ?? ZERO_HASH) as `0x${string}`,
      digest: trigger.digest,
      chainId: this.chainId,
    });

    const plan: OrchestrationPlan = { requestHash };

    if (trigger.txHash ?? txHash) {
      plan.validationRequest = {
        to: this.registries.validation as `0x${string}`,
        data: encodeFunctionData({
          abi: VALIDATION_ABI,
          functionName: "validationRequest",
          args: [
            this.config.watcherKey.address, // validatorAddress == watcher (TEE job key)
            this.config.agentId,
            verdictRequestUri(trigger.digest),
            requestHash,
          ],
        }),
        from: "ops",
      };
      plan.validationResponse = {
        to: this.registries.validation as `0x${string}`,
        data: encodeFunctionData({
          abi: VALIDATION_ABI,
          functionName: "validationResponse",
          args: [
            requestHash,
            SCORE_BY_OUTCOME[outcome],
            verdictRequestUri(trigger.digest),
            trigger.digest, // responseHash == verdict digest
            TAG_RESPONSE,
          ],
        }),
        from: "watcher",
      };
    }

    plan.feedback = {
      to: this.registries.reputation as `0x${string}`,
      data: encodeFunctionData({
        abi: REPUTATION_ABI,
        functionName: "giveFeedback",
        args: [
          this.config.agentId,
          VALUE_BY_OUTCOME[outcome],
          VALUE_DECIMALS,
          TAG1,
          TAG2_BY_OUTCOME[outcome],
          verdictEndpoint(trigger.digest),
          "", // feedbackURI — the endpoint above already points at the verdict
          trigger.digest, // feedbackHash binds the entry to the verdict
        ],
      }),
      from: "reputation",
    };

    return plan;
  }

  /**
   * Full cycle for one trigger: plan → skip-if-posted → sign+send each
   * step with its own key. Returns the tx hashes sent (in order).
   * Requires rpcUrl so writes actually reach the registries.
   */
  async handle(trigger: VerdictTrigger, txHash?: `0x${string}`): Promise<readonly `0x${string}`[]> {
    const plan = this.planFor(trigger, txHash);
    if (!plan.feedback && !plan.validationRequest) return []; // nothing to do

    // One-time-write idempotency: if the requestHash already has a
    // registry entry, the round-trip already happened — skip it.
    if (plan.requestHash && this.validations) {
      const existing = await this.validations.getValidationStatus(plan.requestHash).catch(() => undefined);
      if (existing) {
        this.posted.add(trigger.digest);
        return [];
      }
    }

    const senders = {
      ops: this.config.opsKey,
      watcher: this.config.watcherKey,
      reputation: this.config.reputationKey,
    } as const;

    const sent: `0x${string}`[] = [];
    for (const step of [plan.validationRequest, plan.validationResponse, plan.feedback]) {
      if (!step) continue;
      const account = senders[step.from];
      const wallet: WalletClient = createWalletClient({
        account,
        transport: http(this.config.rpcUrl),
      });
      sent.push(
        await wallet.sendTransaction({
          account,
          to: step.to as Address,
          data: step.data as Hex,
          chain: null, // chain ID taken from the RPC at signing time
          // viem's Chain | null typing needs the escape hatch here; the
          // orchestrator is wired against a fixed chain in prod anyway.
        } as never),
      );
    }
    if (plan.feedback) this.posted.add(trigger.digest);
    return sent;
  }

  /** Mark a digest as handled without sending (receipt reconciliation). */
  markPosted(digest: `0x${string}`): void {
    this.posted.add(digest);
  }
}

const ZERO_HASH = `0x${"00".repeat(32)}` as const;
/** validationResponse tag — distinct from the reputation tag1. */
const TAG_RESPONSE = "bulwark-verdict";

export function createOrchestrator(config: OrchestratorConfig): Erc8004Orchestrator {
  return new Erc8004Orchestrator(config);
}
