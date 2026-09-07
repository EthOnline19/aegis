/**
 * Protocol deployment + wiring for the demo (and any anvil session).
 * Deploys the five contracts + USDC mock, wires them, funds the pool,
 * attaches Atlas's policy — then hands back typed contract handles.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  publicActions,
  getContract,
  encodeAbiParameters,
  keccak256,
  type PublicClient,
  type WalletClient,
  type Address,
  type GetContractReturnType,
  type Abi,
} from "viem";
import { anvil } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import POLICY_REGISTRY from "../../../contracts/out/PolicyRegistry.sol/PolicyRegistry.json";
import GUARD_ACCOUNT from "../../../contracts/out/GuardAccount.sol/GuardAccount.json";
import VERDICT_CONTRACT from "../../../contracts/out/VerdictContract.sol/VerdictContract.json";
import MUTUAL_POOL from "../../../contracts/out/MutualPool.sol/MutualPool.json";
import BLOCKLIST from "../../../contracts/out/Blocklist.sol/Blocklist.json";
import USDC_MOCK from "../../../contracts/out/USDCMock.sol/USDCMock.json";
import type { Policy } from "@bulwark/engine";

export const ALICE = "0x328809bc894f92807417d2dad6b7c998c1afdac6";
export const BOB = "0x1d96f2f6bef1202e4ce1ff6dad0c2cb002861d3e";
export const CAROL = "0xa4d4c1f8a763ef6a0140d04291eceef913ffc272";
export const FRESH_WALLET = "0x55405807c2766d2cb3724d671cc6c30458de6501";
export const ATTACKER = "0x9f2c8a11b6c4d3e5f7a8b9c0d1e2f3a4b5c6d7e8";

const WATCHER_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const AGENT_KEY_PK = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";

/** Demo actors (deterministic anvil keys). */
export const WATCHER: PrivateKeyAccount = privateKeyToAccount(WATCHER_PK);
export const AGENT_KEY: PrivateKeyAccount = privateKeyToAccount(AGENT_KEY_PK);

const MAX_UINT256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;

/** A wallet client that can also read. */
export type ReadWriteClient = WalletClient & ReturnType<typeof publicActions>;

/** Typed contract handle from viem's getContract. */
export type Contract<TAbi extends Abi> = GetContractReturnType<TAbi, PublicClient, WalletClient>;

export interface Protocol {
  readonly usdc: Contract<typeof USDC_MOCK.abi>;
  readonly registry: Contract<typeof POLICY_REGISTRY.abi>;
  readonly guard: Contract<typeof GUARD_ACCOUNT.abi>;
  readonly verdicts: Contract<typeof VERDICT_CONTRACT.abi>;
  readonly pool: Contract<typeof MUTUAL_POOL.abi>;
  readonly blocklist: Contract<typeof BLOCKLIST.abi>;
  /** Atlas's policy, engine-view form (mirrors the on-chain attach). */
  readonly policy: Policy;
}

export interface DeployAccounts {
  readonly amara: PrivateKeyAccount;
  readonly ravi: PrivateKeyAccount;
  readonly senior: PrivateKeyAccount;
}

/** viem clients shared by the demo (anvil transport). */
export function clients(): { public: PublicClient; amara: ReadWriteClient; agent: ReadWriteClient; watcher: ReadWriteClient } {
  const pub = createPublicClient({ chain: anvil, transport: http() });
  const rw = (account: PrivateKeyAccount): ReadWriteClient =>
    createWalletClient({ account, chain: anvil, transport: http() }).extend(publicActions);
  return {
    public: pub,
    amara: rw(privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")),
    agent: rw(AGENT_KEY),
    watcher: rw(WATCHER),
  };
}

/** Deploy the full protocol, wire it, seed the pool, attach Atlas's policy. */
export async function deployProtocol(
  c: ReturnType<typeof clients>,
  accounts: DeployAccounts,
): Promise<Protocol> {
  const deployer = c.amara;
  const amaraAddr = accounts.amara.address;

  // --- Deploy (bytecode lives in the forge artifacts). ---
  const usdcAddr = await deployContract(deployer, USDC_MOCK.abi, USDC_MOCK.bytecode.object, []);
  const registryAddr = await deployContract(deployer, POLICY_REGISTRY.abi, POLICY_REGISTRY.bytecode.object, []);
  const blocklistAddr = await deployContract(deployer, BLOCKLIST.abi, BLOCKLIST.bytecode.object, []);
  const verdictsAddr = await deployContract(
    deployer,
    VERDICT_CONTRACT.abi,
    VERDICT_CONTRACT.bytecode.object,
    [registryAddr, blocklistAddr],
  );
  const poolAddr = await deployContract(deployer, MUTUAL_POOL.abi, MUTUAL_POOL.bytecode.object, [
    usdcAddr,
    amaraAddr,
  ]);
  const guardAddr = await deployContract(deployer, GUARD_ACCOUNT.abi, GUARD_ACCOUNT.bytecode.object, [
    amaraAddr,
    AGENT_KEY.address,
    registryAddr,
    blocklistAddr,
    usdcAddr,
  ]);

  // --- Wire. ---
  await tx(deployer, verdictsAddr, VERDICT_CONTRACT.abi, "setWatcher", [WATCHER.address]);
  await tx(deployer, verdictsAddr, VERDICT_CONTRACT.abi, "setPool", [poolAddr]);
  await tx(deployer, poolAddr, MUTUAL_POOL.abi, "setVerdictContract", [verdictsAddr]);
  await tx(deployer, blocklistAddr, BLOCKLIST.abi, "setReporter", [verdictsAddr, true]);
  await tx(deployer, guardAddr, GUARD_ACCOUNT.abi, "setVerdictContract", [verdictsAddr]);

  // --- Fund. ---
  await tx(deployer, usdcAddr, USDC_MOCK.abi, "mint", [guardAddr, parseUnits("4000", 6)]);
  await tx(deployer, usdcAddr, USDC_MOCK.abi, "mint", [accounts.ravi.address, parseUnits("20000", 6)]);
  await tx(deployer, usdcAddr, USDC_MOCK.abi, "mint", [accounts.senior.address, parseUnits("25000", 6)]);
  const ravi = asRw(accounts.ravi);
  const senior = asRw(accounts.senior);
  await tx(ravi, usdcAddr, USDC_MOCK.abi, "approve", [poolAddr, MAX_UINT256]);
  await tx(ravi, poolAddr, MUTUAL_POOL.abi, "deposit", [1, parseUnits("20000", 6)]);
  await tx(senior, usdcAddr, USDC_MOCK.abi, "approve", [poolAddr, MAX_UINT256]);
  await tx(senior, poolAddr, MUTUAL_POOL.abi, "deposit", [0, parseUnits("25000", 6)]);

  // --- Attach policy v1. ---
  const policyArgs = {
    version: 1,
    agent: guardAddr,
    owner: amaraAddr,
    coverageCap: parseUnits("2500", 6),
    deductibleBps: 1000,
    perTxLimit: parseUnits("200", 6),
    dailyLimit: parseUnits("1000", 6),
    velocityLimit: 5,
    allowlist: [
      { recipient: ALICE, cap: parseUnits("200", 6) },
      { recipient: BOB, cap: parseUnits("400", 6) },
    ],
    curfewStart: 1440,
    curfewEnd: 1440,
    holdWindowSec: 120,
    sdkInstalled: true,
  };
  await tx(deployer, registryAddr, POLICY_REGISTRY.abi, "attach", [guardAddr, policyArgs]);

  // --- Contract handles. ---
  const handle = <TAbi extends Abi>(address: Address, abi: TAbi): Contract<TAbi> =>
    getContract({ address, abi, client: { public: c.public, wallet: c.amara } }) as Contract<TAbi>;

  return {
    usdc: handle(usdcAddr, USDC_MOCK.abi),
    registry: handle(registryAddr, POLICY_REGISTRY.abi),
    guard: handle(guardAddr, GUARD_ACCOUNT.abi),
    verdicts: handle(verdictsAddr, VERDICT_CONTRACT.abi),
    pool: handle(poolAddr, MUTUAL_POOL.abi),
    blocklist: handle(blocklistAddr, BLOCKLIST.abi),
    policy: {
      version: 1,
      agent: guardAddr,
      owner: amaraAddr,
      coverageCap: parseUnits("2500", 6),
      deductibleBps: 1000,
      perTxLimit: parseUnits("200", 6),
      dailyLimit: parseUnits("1000", 6),
      velocityLimit: 5,
      allowlist: [
        { recipient: ALICE as `0x${string}`, cap: parseUnits("200", 6) },
        { recipient: BOB as `0x${string}`, cap: parseUnits("400", 6) },
      ],
      curfewStartMinute: 1440,
      curfewEndMinute: 1440,
      holdWindowSec: 120,
      sdkInstalled: true,
    },
  };
}

/** Submit a signed COVERED verdict; the pool pays the claimant same tx. */
export async function submitCoveredVerdict(
  p: Protocol,
  c: ReturnType<typeof clients>,
  claim: { txHash: string; destination: string; loss: bigint; payout: bigint },
): Promise<void> {
  // Digest must match on-chain verdictDigest: keccak(abi.encode(fields...)).
  // We compute it exactly as BulwarkTypes.verdictDigest does.
  const policyHash = await p.registry.read.policyHashAt([p.policy.agent, 1]);
  const timestamp = (await c.public.getBlock()).timestamp; // chain clock: freshness window is chain-relative
  const digest = verdictDigest({
    policyHash,
    agent: p.policy.agent,
    claimant: p.policy.owner,
    txHash: claim.txHash as `0x${string}`,
    destination: claim.destination as `0x${string}`,
    lossAmount: claim.loss,
    payoutAmount: claim.payout,
    alibi: 1, // EXTERNAL
    outcome: 1, // COVERED
    timestamp,
  });
  const signature = await c.watcher.signMessage({ message: { raw: digest } });

  const hash = await c.watcher.writeContract({
    address: p.verdicts.address,
    abi: VERDICT_CONTRACT.abi,
    functionName: "submitVerdict",
    args: [
      {
        policyHash,
        agent: p.policy.agent,
        claimant: p.policy.owner,
        txHash: claim.txHash as `0x${string}`,
        destination: claim.destination as `0x${string}`,
        lossAmount: claim.loss,
        payoutAmount: claim.payout,
        alibi: 1,
        outcome: 1,
        reasons: [],
        timestamp,
      },
      signature,
    ],
    chain: anvil,
    account: WATCHER,
  });
  const receipt = await c.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("submitVerdict failed");
}

/** Submit a signed hold verdict (clean=0 / suspicious=1) via VerdictContract. */
export async function submitHoldVerdict(
  p: Protocol,
  c: ReturnType<typeof clients>,
  holdId: bigint,
  tier: 0 | 1,
): Promise<void> {
  const policyHash = await p.registry.read.policyHashAt([p.policy.agent, 1]);
  const raw = keccak256(
    encodeAbiParameters(
      [
        { name: "holdId", type: "uint256" },
        { name: "agent", type: "address" },
        { name: "policyHash", type: "bytes32" },
        { name: "tier", type: "uint8" },
      ],
      [holdId, p.policy.agent, policyHash, BigInt(tier)],
    ),
  );
  const signature = await c.watcher.signMessage({ message: { raw } });
  await c.watcher.writeContract({
    address: p.verdicts.address,
    abi: VERDICT_CONTRACT.abi,
    functionName: "submitHoldVerdict",
    args: [holdId, p.policy.agent, policyHash, tier, signature],
    chain: anvil,
    account: WATCHER,
  });
}

// ------------------------------------------------------------------ //
//                        Internals                                   //
// ------------------------------------------------------------------ //

/**
 * Mirrors BulwarkTypes.verdictDigest exactly: keccak256(abi.encode(...))
 * of every verdict field except `reasons` (on-chain digest excludes it —
 * see contracts/src/BulwarkTypes.sol).
 */
function verdictDigest(v: {
  policyHash: `0x${string}`;
  agent: `0x${string}`;
  claimant: `0x${string}`;
  txHash: `0x${string}`;
  destination: `0x${string}`;
  lossAmount: bigint;
  payoutAmount: bigint;
  alibi: number;
  outcome: number;
  timestamp: bigint;
}): `0x${string}` {
  // Exactly BulwarkTypes.verdictDigest: abi.encode of the 11 fields —
  // INCLUDING the (empty) reasons array, encoded as its tuple type.
  const reasonType = { components: [
    { name: "tag", type: "bytes4" },
    { name: "provenance", type: "uint8" },
    { name: "detail", type: "string" },
  ], name: "reasons", type: "tuple[]" } as const;
  const encoded = encodeAbiParameters(
    [
      { name: "policyHash", type: "bytes32" },
      { name: "agent", type: "address" },
      { name: "claimant", type: "address" },
      { name: "txHash", type: "bytes32" },
      { name: "destination", type: "address" },
      { name: "lossAmount", type: "uint96" },
      { name: "payoutAmount", type: "uint96" },
      { name: "alibi", type: "uint8" },
      { name: "outcome", type: "uint8" },
      reasonType,
      { name: "timestamp", type: "uint64" },
    ],
    [
      v.policyHash,
      v.agent,
      v.claimant,
      v.txHash,
      v.destination,
      v.lossAmount,
      v.payoutAmount,
      BigInt(v.alibi),
      BigInt(v.outcome),
      [], // reasons: empty in the demo verdict
      v.timestamp,
    ],
  );
  return keccak256(encoded);
}

function asRw(account: PrivateKeyAccount): ReadWriteClient {
  return createWalletClient({ account, chain: anvil, transport: http() }).extend(publicActions);
}

async function deployContract(
  client: ReadWriteClient,
  abi: Abi,
  bytecode: string,
  args: readonly unknown[],
): Promise<Address> {
  const hash = await client.deployContract({
    abi,
    bytecode: bytecode as `0x${string}`,
    args: args as never[],
    account: client.account,
    chain: anvil,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy failed: no contract address");
  return receipt.contractAddress;
}

async function tx(
  client: ReadWriteClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const hash = await client.writeContract({
    address,
    abi,
    functionName,
    args: args as never[],
    account: client.account,
    chain: anvil,
  });
  await client.waitForTransactionReceipt({ hash });
}
