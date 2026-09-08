/**
 * Step 4 smoke test (design §7.2): one full ERC-8004 round-trip against
 * the LIVE canonical Arc testnet registries — register → bind guard
 * wallet → validationRequest → validationResponse → giveFeedback —
 * fork-free (public RPC), using three fresh BULWARK-role keys.
 *
 * Run: bun run packages/api/scripts/arc-smoke.ts
 *
 * Prerequisites, documented in docs/ERC8004_DESIGN.md §7:
 *  - gas: Arc testnet uses USDC as gas; the ops/watcher/reputation keys
 *    each need a drip (faucet.circle.com, 20 USDC / 2h / address).
 *  - the smoke keys are disposable; nothing here touches real funds.
 *
 * Exit code 0 = full round-trip readable back from the live registries.
 */
import { concatBytes } from "@noble/hashes/utils";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toBytes,
  toHex,
  type Abi,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  ARC_TESTNET_CHAIN_ID,
  IDENTITY_ABI,
  REPUTATION_ABI,
  SCORE_BY_OUTCOME,
  TAG1,
  TAG2_BY_OUTCOME,
  VALIDATION_ABI,
  VALUE_BY_OUTCOME,
  VALUE_DECIMALS,
  deriveRequestHash,
  erc8004ForChain,
  type Erc8004Registries,
} from "@bulwark/agent-sdk";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io";

const OPS_PK = process.env.ARC_SMOKE_OPS_KEY;
const WATCHER_PK = process.env.ARC_SMOKE_WATCHER_KEY;
const REPUTATION_PK = process.env.ARC_SMOKE_REPUTATION_KEY;

if (!OPS_PK || !WATCHER_PK || !REPUTATION_PK) {
  console.error(
    "Set ARC_SMOKE_OPS_KEY / ARC_SMOKE_WATCHER_KEY / ARC_SMOKE_REPUTATION_KEY " +
      "(funded with testnet USDC — Arc uses USDC for gas).",
  );
  process.exit(2);
}

const ops = privateKeyToAccount(OPS_PK as `0x${string}`);
const watcher = privateKeyToAccount(WATCHER_PK as `0x${string}`);
const reputation = privateKeyToAccount(REPUTATION_PK as `0x${string}`);

const registries: Erc8004Registries = erc8004ForChain(ARC_TESTNET_CHAIN_ID);
const reader = createPublicClient({ transport: http(RPC) });

/** One write, awaited to receipt, from the named key. */
async function send(
  label: string,
  account: PrivateKeyAccount,
  to: string,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<`0x${string}`> {
  const data = encodeFunctionData({ abi, functionName, args: args as never });
  const wallet = createWalletClient({ account, transport: http(RPC) });
  const hash = await wallet.sendTransaction({
    account,
    to: to as `0x${string}`,
    data: data as `0x${string}`,
    chain: null,
  } as never);
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted on-chain`);
  console.log(`  ${label}: ${hash}`);
  return hash;
}

async function main(): Promise<void> {
  console.log(`Arc smoke test — RPC ${RPC}, chainId ${ARC_TESTNET_CHAIN_ID}`);
  console.log(`  ops        ${ops.address}`);
  console.log(`  watcher    ${watcher.address}`);
  console.log(`  reputation ${reputation.address}`);

  // 1. register → agentId
  const agentUri = `bulwark://agents/atlas-smoke-${Date.now()}.json`;
  const regHash = await send("register", ops, registries.identity, IDENTITY_ABI, "register", [agentUri]);
  const regReceipt = await reader.waitForTransactionReceipt({ hash: regHash });
  const agentIdBig = BigInt(regReceipt.logs[0]?.topics[3] ?? keccak256(toHex("missing")));
  console.log(`  agentId ${agentIdBig}`);

  // 2. bind guard wallet: EIP-712 AgentWalletSet, signed by the GUARD key.
  //    For the smoke test the guard IS the reputation key (an EOA we hold);
  //    deadline must be within [now, now+5min].
  const guard = reputation;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
  const domain = {
    name: "ERC8004IdentityRegistry",
    version: "1",
    chainId: ARC_TESTNET_CHAIN_ID,
    verifyingContract: registries.identity as `0x${string}`,
  };
  const types = {
    AgentWalletSet: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "owner", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const message = { agentId: agentIdBig, newWallet: guard.address, owner: ops.address, deadline };
  const signature = await guard.signTypedData({ domain, types, primaryType: "AgentWalletSet", message } as never);
  await send("setAgentWallet", ops, registries.identity, IDENTITY_ABI, "setAgentWallet", [
    agentIdBig,
    guard.address,
    deadline,
    signature,
  ]);
  const bound = (await reader.readContract({
    address: registries.identity as `0x${string}`,
    abi: IDENTITY_ABI,
    functionName: "getAgentWallet",
    args: [agentIdBig],
  })) as string;
  if (bound.toLowerCase() !== guard.address.toLowerCase()) throw new Error(`binding failed: ${bound}`);
  console.log(`  guard bound: ${bound}`);

  // 3. one validation round-trip + the reputation mirror. requestHash uses
  //    the SDK's pinned formula (agentId, guard, txHash, digest, chainId).
  const digest = keccak256(toHex(`smoke:${Date.now()}`)) as `0x${string}`;
  const txHash = keccak256(toHex(`smoketx:${Date.now()}`)) as `0x${string}`;
  const requestHash = deriveRequestHash({
    agentId: agentIdBig,
    guardAccount: guard.address as `0x${string}`,
    txHash,
    digest,
    chainId: ARC_TESTNET_CHAIN_ID,
  });
  console.log(`  requestHash ${requestHash}`);

  await send("validationRequest", ops, registries.validation, VALIDATION_ABI, "validationRequest", [
    watcher.address,
    agentIdBig,
    `https://api.bulwark.eth/v1/verdicts/${digest}`,
    requestHash,
  ]);
  await send("validationResponse", watcher, registries.validation, VALIDATION_ABI, "validationResponse", [
    requestHash,
    SCORE_BY_OUTCOME.ATTEMPTED,
    `https://api.bulwark.eth/v1/verdicts/${digest}`,
    digest,
    "bulwark-verdict",
  ]);
  await send("giveFeedback", reputation, registries.reputation, REPUTATION_ABI, "giveFeedback", [
    agentIdBig,
    VALUE_BY_OUTCOME.ATTEMPTED,
    VALUE_DECIMALS,
    TAG2_BY_OUTCOME.ATTEMPTED,
    `bulwark://verdicts/${digest}`,
    "",
    digest,
  ]);

  // 4. read it all back from the live registries
  const status = (await reader.readContract({
    address: registries.validation as `0x${string}`,
    abi: VALIDATION_ABI,
    functionName: "getValidationStatus",
    args: [requestHash],
  })) as readonly [string, bigint, number, string, string, bigint];
  console.log(`  validation status: response=${status[2]} tag=${status[4]}`);
  if (status[2] !== SCORE_BY_OUTCOME.ATTEMPTED) throw new Error("validation response mismatch");

  const feedback = (await reader.readContract({
    address: registries.reputation as `0x${string}`,
    abi: REPUTATION_ABI,
    functionName: "readFeedback",
    // registry feedback indexes are 1-based ("index must be > 0" revert)
    args: [agentIdBig, reputation.address, 1n],
  })) as readonly [bigint, number, string, string, boolean];
  console.log(`  feedback: value=${feedback[0]} tag1=${feedback[2]} tag2=${feedback[3]}`);
  if (feedback[0] !== VALUE_BY_OUTCOME.ATTEMPTED) throw new Error("feedback value mismatch");

  console.log("ARC SMOKE TEST PASSED — full round-trip on live registries.");
}

void concatBytes; // reserved for future raw-word requestHash variants

main().catch((err: unknown) => {
  console.error("ARC SMOKE TEST FAILED:", err);
  process.exit(1);
});
