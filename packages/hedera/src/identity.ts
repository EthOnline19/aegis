/**
 * REPAYD x402 Identity — cross-chain ERC-8004 agent identity validation.
 *
 * The payer agent identifies itself as ERC-8004 agentId 894341, whose NFT and
 * wallet binding live on the canonical identity registry deployed on Arc
 * testnet (chain 5042002). This module validates that claim with read-only
 * eth_calls — identity on Arc, payments on Hedera, one agent across both.
 *
 * Read-only: no keys, no writes. When ARC_RPC_URL is unset the validator
 * degrades to "unverified" and the service still serves (identity is scored
 * as an extra point, not a paywall gate).
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { ERC8004_AGENT_ID, ERC8004_AGENT_OWNER, ERC8004_AGENT_WALLET } from "./payloads.ts";

/** The canonical ERC-8004 identity registry on Arc testnet. */
export const ERC8004_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.io";
export const ARC_TESTNET_CHAIN_ID = 5042002;

export type IdentityStatus =
  | { readonly status: "verified"; readonly agentId: string; readonly owner: string; readonly wallet: string }
  | { readonly status: "unverified"; readonly reason: string };

export interface IdentityValidator {
  /** Validate the claimed agentId against the canonical registry. */
  validate(agentId: string): Promise<IdentityStatus>;
}

/** ownerOf(uint256) — ERC-721 style. */
const OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * Live validator: read-only eth_calls against the Arc testnet registry.
 * Returns "unverified" (never throws) on any transport/registry problem.
 */
export function arcIdentityValidator(rpcUrl: string): IdentityValidator {
  const client: PublicClient = createPublicClient({
    transport: http(rpcUrl),
  });
  return {
    async validate(agentId: string): Promise<IdentityStatus> {
      try {
        if (agentId !== ERC8004_AGENT_ID.toString()) {
          return { status: "unverified", reason: `unknown agentId ${agentId} (only the Step-4 agent is served)` };
        }
        const owner = (await client.readContract({
          address: ERC8004_IDENTITY_REGISTRY,
          abi: OWNER_OF_ABI,
          functionName: "ownerOf",
          args: [ERC8004_AGENT_ID],
        })) as `0x${string}`;
        const wallet = (await client.readContract({
          address: ERC8004_IDENTITY_REGISTRY,
          abi: OWNER_OF_ABI,
          functionName: "getAgentWallet",
          args: [ERC8004_AGENT_ID],
        })) as `0x${string}`;
        if (owner.toLowerCase() !== ERC8004_AGENT_OWNER.toLowerCase()) {
          return { status: "unverified", reason: "owner mismatch" };
        }
        if (wallet.toLowerCase() !== ERC8004_AGENT_WALLET.toLowerCase()) {
          return { status: "unverified", reason: "wallet binding mismatch" };
        }
        return { status: "verified", agentId, owner, wallet };
      } catch (err) {
        return { status: "unverified", reason: `registry read failed: ${String(err)}` };
      }
    },
  };
}

/** Offline fallback: registry facts are pinned from the verified Step-4 readback. */
export function pinnedIdentityValidator(): IdentityValidator {
  return {
    async validate(agentId: string): Promise<IdentityStatus> {
      if (agentId !== ERC8004_AGENT_ID.toString()) {
        return { status: "unverified", reason: `unknown agentId ${agentId}` };
      }
      return {
        status: "verified",
        agentId,
        owner: ERC8004_AGENT_OWNER,
        wallet: ERC8004_AGENT_WALLET,
      };
    },
  };
}
