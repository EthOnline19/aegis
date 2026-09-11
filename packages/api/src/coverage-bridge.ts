/**
 * Coverage API → PolicyRegistry bridge (plan §14 → §30).
 *
 * POST /v1/coverage has always returned a policyId from an in-memory store.
 * This module closes the loop: it materializes the requested policy as an
 * on-chain `PolicyRegistry.attach(agent, policy)` transaction, gated on the
 * platform agent being a real GuardAccount, so a platform onboarding at
 * agent birth produces a policy the GuardAccount actually enforces — and a
 * PolicyUpdated event the Risk Subgraph indexes.
 *
 * Authorization mirrors PolicyRegistry.attach: the caller (here, the API
 * platform's key) must BE the GuardAccount's immutable OWNER — the store
 * verifies OWNER on-chain before quoting attach, and attach re-checks
 * against the account itself (C1 front-run review). The platform operator's
 * key must therefore be the guard's owner key; platforms run this bridge
 * with their agents' owner keys, exactly as Deploy.s.sol does for Atlas.
 *
 * Config-gated: with no COVERAGE_PLATFORM_KEY / COVERAGE_RPC_URL env the
 * bridge is unavailable and /v1/coverage behaves exactly as before
 * (store-only). Set both (plus optional COVERAGE_REGISTRY_ADDRESS to
 * override the deployment record) to enable on-chain attach.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { PolicyRequest } from "./schemas.ts";
import { loadDeployment } from "./deployment.ts";

/** On-chain mirror of schemas.ts PolicyRequest (no version — registry assigns). */
interface OnChainPolicy {
  agent: string;
  owner: string;
  coverageCap: bigint;
  deductibleBps: number;
  perTxLimit: bigint;
  dailyLimit: bigint;
  velocityLimit: number;
  allowlist: readonly { recipient: string; cap: bigint }[];
  curfewStart: number; // 1440 = no curfew
  curfewEnd: number;
  holdWindowSec: number;
  sdkInstalled: boolean;
}

const POLICY_REGISTRY_ABI = parseAbi([
  "function attach(address agent, (uint32,address,address,uint96,uint16,uint96,uint96,uint32,(address,uint96)[],uint32,uint32,uint32,bool) policy)",
  "function latestVersion(address) view returns (uint32)",
  "function policyHashAt(address agent, uint32 version) view returns (bytes32)",
]);

const GUARD_ACCOUNT_ABI = parseAbi(["function OWNER() view returns (address)"]);

const NO_CURFEW = 1440;

/** Everything needed to send one attach() from the platform's owner key. */
export interface BridgeConfig {
  readonly rpcUrl: string;
  readonly privateKey: `0x${string}`;
  readonly registryAddress?: `0x${string}`;
}

export interface AttachResult {
  readonly txHash: `0x${string}`;
  readonly registry: `0x${string}`;
  readonly agent: string;
  readonly version: number;
  readonly policyHash: `0x${string}`;
}

/** Resolve bridge config from env; null = bridge disabled (store-only mode). */
export function bridgeFromEnv(
  env: Record<string, string | undefined> = process.env,
): BridgeConfig | null {
  const pk = env["COVERAGE_PLATFORM_KEY"];
  const rpc = env["COVERAGE_RPC_URL"];
  if (!pk || !rpc) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("COVERAGE_PLATFORM_KEY must be a 0x-prefixed 32-byte private key");
  }
  return {
    rpcUrl: rpc,
    privateKey: pk as `0x${string}`,
    registryAddress: env["COVERAGE_REGISTRY_ADDRESS"] as `0x${string}` | undefined,
  };
}

/**
 * True when `wallet` is a contract whose immutable OWNER() equals the
 * bridge signer — i.e. the platform key is the guard's owner key and attach
 * will pass PolicyRegistry's first-attach check.
 */
export async function verifyGuardOwnership(
  config: BridgeConfig,
  agentWallet: string,
): Promise<{ ok: true; owner: string } | { ok: false; reason: string }> {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const code = await client.getBytecode({ address: agentWallet as `0x${string}` });
  if (!code || code === "0x") {
    return { ok: false, reason: "agentWallet is an EOA — coverage requires a GuardAccount" };
  }
  let owner: string;
  try {
    owner = (await client.readContract({
      address: agentWallet as `0x${string}`,
      abi: GUARD_ACCOUNT_ABI,
      functionName: "OWNER",
    })) as string;
  } catch {
    return { ok: false, reason: "agentWallet has no OWNER() — not a GuardAccount" };
  }
  const signer = privateKeyToAccount(config.privateKey).address.toLowerCase();
  if (owner.toLowerCase() !== signer) {
    return {
      ok: false,
      reason: `signer ${signer} is not the GuardAccount OWNER ${owner.toLowerCase()}`,
    };
  }
  return { ok: true, owner };
}

/** Map an API PolicyRequest onto the on-chain BulwarkTypes.Policy shape. */
export function toOnChainPolicy(
  req: PolicyRequest,
  agent: string,
  owner: string,
): OnChainPolicy {
  if (req.perTx > req.cap) throw new Error("policy.perTx must be <= policy.cap"); // re-check
  return {
    agent,
    owner,
    coverageCap: req.cap,
    deductibleBps: req.deductibleBps ?? 1000,
    perTxLimit: req.perTx,
    dailyLimit: req.daily,
    velocityLimit: req.velocity,
    allowlist: req.allowlist.map((recipient) => ({ recipient, cap: 0n })),
    curfewStart: NO_CURFEW,
    curfewEnd: NO_CURFEW,
    holdWindowSec: req.holdWindowSec ?? 120,
    sdkInstalled: true, // platforms onboard with the SDK pre-installed (§27)
  };
}

/**
 * Broadcast PolicyRegistry.attach(agent, policy) from the owner key and
 * return the tx hash plus the registry-assigned version. Registry address
 * resolution order: config override → deployment record for the RPC's
 * chainId → error.
 */
export async function attachOnChain(
  config: BridgeConfig,
  req: PolicyRequest,
  agentWallet: string,
): Promise<AttachResult> {
  const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  const chainId = await publicClient.getChainId();

  let registry = config.registryAddress;
  if (!registry) {
    const record = await loadDeployment(chainId);
    registry = record.contracts.policyRegistry as `0x${string}`;
  }

  const ownership = await verifyGuardOwnership(config, agentWallet);
  if (!ownership.ok) throw new Error(`attach precheck failed: ${ownership.reason}`);

  const account: PrivateKeyAccount = privateKeyToAccount(config.privateKey);
  const wallet = createWalletClient({ account, transport: http(config.rpcUrl) });

  const policy = toOnChainPolicy(req, agentWallet, ownership.owner);

  const version = Number(
    await publicClient.readContract({
      address: registry,
      abi: POLICY_REGISTRY_ABI,
      functionName: "latestVersion",
      args: [agentWallet as `0x${string}`],
    }),
  );

  const nextVersion = version + 1;
  const agentAddr = agentWallet as `0x${string}`;
  // viem's encodeFunctionData with UNNAMED tuple components requires
  // positional values (object-keyed values only bind when components have
  // names). Keep the order locked to the BulwarkTypes.Policy field order.
  const data = encodeFunctionData({
    abi: POLICY_REGISTRY_ABI,
    functionName: "attach",
    args: [
      agentAddr,
      [
        nextVersion,
        policy.agent as `0x${string}`,
        policy.owner as `0x${string}`,
        policy.coverageCap,
        policy.deductibleBps,
        policy.perTxLimit,
        policy.dailyLimit,
        policy.velocityLimit,
        policy.allowlist.map((e) => [e.recipient as `0x${string}`, e.cap] as const),
        policy.curfewStart,
        policy.curfewEnd,
        policy.holdWindowSec,
        policy.sdkInstalled,
      ],
    ],
  });

  const txHash = await wallet.sendTransaction({
    account,
    to: registry,
    data,
    chain: null,
  } as never);

  return {
    txHash,
    registry,
    agent: agentWallet,
    version: nextVersion,
    policyHash: (await publicClient.readContract({
      address: registry,
      abi: POLICY_REGISTRY_ABI,
      functionName: "policyHashAt",
      args: [agentAddr, nextVersion],
    })) as `0x${string}`,
  };
}
