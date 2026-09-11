/**
 * BULWARK ENSv2 writer/resolver — the insurance résumé on ENSv2 (Sepolia beta).
 *
 * Flow (verified by the track research doc, §1.3–1.5 of
 * local://ens-graph-research.md — every address read from
 * docs.ens.domains/learn/deployments or verified by read-only RPC):
 *
 *   0. deployProxy(PermissionedResolverImpl, salt, initialize(owner, ALL_ROLES,
 *      setters=[setText(resume), setText(chainhead)]))   — resolver proxy,
 *      résumé baked into init (PublicResolverV2 is NOT usable for fresh v2
 *      names: its auth requires the v1 NameWrapper).
 *   1. approve(MockUSDC, base + premium)                   — registration is
 *      ERC20-only; ~8 MockUSDC for 1yr of a 5+char label.
 *   2. commit(makeCommitment(label, owner, secret, subregistry=0, resolver,
 *      duration, referrer))                               — anti-frontrun.
 *   3. wait MIN_COMMITMENT_AGE (60s).
 *   4. register(label, owner, secret, 0, resolver, duration, MockUSDC, referrer).
 *
 * HARD GATE: nothing here sends a transaction unless the caller passes a
 * wallet client, and scripts only construct one when ENSETH_PRIVATE_KEY and
 * ENSV2_RPC_URL are both set. The default is a dry run that prints the exact
 * transactions it WOULD send — zero network writes.
 */

import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import { toEnsTextRecords, type Resume } from "./resume.ts";

// ------------------------------------------------------------------ //
//              Sepolia ENSv2 beta — verified addresses                //
// ------------------------------------------------------------------ //

export const ENSV2_ADDRESSES = {
  ethRegistrar: "0xa88553f454b77203b0d036a05c894d555eaaa2cc",
  ethRegistry: "0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2",
  verifiableFactory: "0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef",
  permissionedResolverImpl: "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e",
  universalResolverProxy: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  mockUsdc: "0x768f42455a2d082e23ceef7d51e5787c82d67a39",
} as const satisfies Record<string, Address>;

export const MIN_COMMITMENT_AGE_SECONDS = 60;
/** 1 year, in seconds — the registration duration. */
export const ONE_YEAR = 60n * 60n * 24n * 365n;

/** Text keys on the resolver (ENSIP-5, our namespace). */
export const ENSV2_TEXT_KEYS = {
  /** The full §13 résumé block, one string. */
  resume: "com.bulwark.resume",
  /** Instruction hash-chain head (the alibi anchor). */
  chainhead: "com.bulwark.chainhead",
} as const;

// ------------------------------------------------------------------ //
//                              ABIs                                   //
// ------------------------------------------------------------------ //

export const ethRegistrarAbi = parseAbi([
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)",
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "event CommitmentMade(bytes32 commitment)",
  "event NameRegistered(uint256 tokenId, string label, address owner, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer, uint256 base, uint256 premium)",
]);

export const verifiableFactoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address proxyAddress, uint256 salt, address implementation)",
]);

export const permissionedResolverAbi = parseAbi([
  "function initialize(address admin, uint256 roleBitmap, bytes[] setters)",
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
  "function setAddr(bytes32 node, address a)",
  "function addr(bytes32 node) view returns (address)",
  "event TextChanged(bytes32 node, bytes32 indexedKey, string key, string value)",
]);

export const erc20MinimalAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

// ------------------------------------------------------------------ //
//                        Core construction                            //
// ------------------------------------------------------------------ //

/** All-roles bitmap for the resolver initialize (per ENSv2 docs example). */
export const ALL_ROLES =
  0x1111111111111111111111111111111111111111111111111111111111111111n;

/** The registration plan — what register.ts prints (dry run) or sends. */
export interface RegistrationPlan {
  readonly label: string;
  readonly name: string; // e.g. "bulwark.eth"
  readonly owner: Address;
  readonly resolver: Address; // the deployed (or to-be-deployed) proxy
  readonly resolverDeploy: {
    readonly to: Address;
    readonly data: `0x${string}`; // deployProxy(impl, salt, initData)
    readonly salt: bigint;
  };
  readonly approve: {
    readonly to: Address; // MockUSDC
    readonly spender: Address; // ETHRegistrar
    readonly amount: bigint; // base + premium (6dp)
  };
  readonly commit: {
    readonly to: Address; // ETHRegistrar
    readonly data: `0x${string}`; // commit(commitment)
    readonly commitment: `0x${string}`;
    readonly secret: `0x${string}`;
  };
  readonly register: {
    readonly to: Address; // ETHRegistrar
    readonly data: `0x${string}`; // register(...)
  };
  readonly waitSeconds: number; // MIN_COMMITMENT_AGE
  readonly textRecords: Record<string, string>; // baked into resolver init
}

/** Read-only Sepolia client for all ENSv2 calls. */
export interface Ensv2PublicClient {
  readContract: ReturnType<typeof createPublicClient>["readContract"];
  waitForTransactionReceipt: ReturnType<typeof createPublicClient>["waitForTransactionReceipt"];
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * CREATE2 salt for the resolver proxy — deterministic per owner
 * (keccak256(keccak256("OwnedResolver"), owner, version)), per the
 * canonical ENSv2 verifiable-factory example.
 */
export function resolverProxySalt(owner: Address, version = 0n): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [keccak256(stringToHex("OwnedResolver")), owner, version],
      ),
    ),
  );
}

/**
 * Build the full registration plan — pure, no network, no side effects.
 * The resolver deploy initData bakes the résumé text records into the
 * proxy's `setters` array, so the records land in the SAME tx as the
 * resolver deploy (permission checks bypassed during init, per §1.4).
 */
export function buildRegistrationPlan(args: {
  label: string;
  owner: Address;
  secret: `0x${string}`;
  resolver?: Address; // omit to deploy a fresh proxy in the plan
  durationSeconds?: bigint;
  paymentToken?: Address;
  resume: Resume;
  chainHead: `0x${string}`;
}): RegistrationPlan {
  const {
    label,
    owner,
    secret,
    resume,
    chainHead,
    durationSeconds = ONE_YEAR,
    paymentToken = ENSV2_ADDRESSES.mockUsdc,
  } = args;

  const name = `${label}.eth`;
  const node = namehash(name);

  // Résumé → resolver text records. The full block under com.bulwark.resume,
  // the alibi anchor under com.bulwark.chainhead.
  const textRecords: Record<string, string> = {
    ...toEnsTextRecords(resume),
    [ENSV2_TEXT_KEYS.resume]: renderForChain(resume),
    [ENSV2_TEXT_KEYS.chainhead]: chainHead,
  };

  const setters: `0x${string}`[] = Object.entries(textRecords).map(([key, value]) =>
    encodeFunctionData({
      abi: permissionedResolverAbi,
      functionName: "setText",
      args: [node, key, value],
    }),
  );

  const salt = resolverProxySalt(owner);
  const initData = encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: "initialize",
    args: [owner, ALL_ROLES, setters],
  });
  const resolverDeployData = encodeFunctionData({
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [ENSV2_ADDRESSES.permissionedResolverImpl, salt, initData],
  });

  // Commitment binds all 7 registration params (anti-frontrun). The
  // resolver address is CREATE2-deterministic only if the proxy already
  // exists; for a fresh deploy the plan registers AFTER the deploy tx and
  // uses the proxy address from the ProxyDeployed event. For the
  // commitment we bind the planned resolver: callers that deploy first
  // must pass the resulting address back in (see register.ts).
  const resolver = args.resolver ?? `0x${"00".repeat(20)}` as Address; // replaced post-deploy
  const commitment = makeCommitment({
    label,
    owner,
    secret,
    subregistry: `0x${"00".repeat(20)}` as Address,
    resolver,
    duration: durationSeconds,
    referrer: `0x${"00".repeat(32)}` as `0x${string}`,
  });

  const registerData = encodeFunctionData({
    abi: ethRegistrarAbi,
    functionName: "register",
    args: [
      label,
      owner,
      secret,
      `0x${"00".repeat(20)}`,
      resolver,
      durationSeconds,
      paymentToken,
      `0x${"00".repeat(32)}`,
    ],
  });

  return {
    label,
    name,
    owner,
    resolver,
    resolverDeploy: {
      to: ENSV2_ADDRESSES.verifiableFactory,
      data: resolverDeployData,
      salt,
    },
    approve: {
      to: paymentToken,
      spender: ENSV2_ADDRESSES.ethRegistrar,
      amount: 0n, // filled from getRegisterPrice at execute time
    },
    commit: {
      to: ENSV2_ADDRESSES.ethRegistrar,
      data: encodeFunctionData({
        abi: ethRegistrarAbi,
        functionName: "commit",
        args: [commitment],
      }),
      commitment,
      secret,
    },
    register: {
      to: ENSV2_ADDRESSES.ethRegistrar,
      data: registerData,
    },
    waitSeconds: MIN_COMMITMENT_AGE_SECONDS,
    textRecords,
  };
}

/** keccak256(abi.encode(label, owner, secret, subregistry, resolver, duration, referrer)). */
export function makeCommitment(args: {
  label: string;
  owner: Address;
  secret: `0x${string}`;
  subregistry: Address;
  resolver: Address;
  duration: bigint;
  referrer: `0x${string}`;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [
        args.label,
        args.owner,
        args.secret,
        args.subregistry,
        args.resolver,
        args.duration,
        args.referrer,
      ],
    ),
  ) as `0x${string}`;
}

/**
 * The com.bulwark.resume value: the rendered §13 block (provenance labels
 * inline), small enough for one text record.
 */
export function renderForChain(resume: Resume): string {
  const lines = [
    `INSURED: ${resume.INSURED.text}`,
    `DRIVING: ${resume.DRIVING.text} [${resume.DRIVING.provenance}]`,
    `CLAIMS: ${resume.CLAIMS.text}`,
    `ALIBI SDK: ${resume.ALIBI.text}`,
    `BACKING: ${resume.BACKING.text}`,
    `STATUS: ${resume.STATUS.text}`,
  ];
  return lines.join("\n");
}

// ------------------------------------------------------------------ //
//                          Execution (gated)                          //
// ------------------------------------------------------------------ //

export function createEnsv2PublicClient(rpcUrl: string) {
  return createPublicClient({
    transport: http(rpcUrl),
    chain: sepolia,
  });
}

/**
 * Pre-flight reads (read-only): is the label free, what does it cost,
 * does the wallet hold enough MockUSDC. No writes.
 */
export async function preflight(client: Ensv2PublicClient, args: {
  label: string;
  wallet: Address;
  paymentToken?: Address;
  durationSeconds?: bigint;
}) {
  const { label, wallet } = args;
  const paymentToken = args.paymentToken ?? ENSV2_ADDRESSES.mockUsdc;
  const duration = args.durationSeconds ?? ONE_YEAR;
  const [available, price, balance] = await Promise.all([
    client.readContract({
      address: ENSV2_ADDRESSES.ethRegistrar,
      abi: ethRegistrarAbi,
      functionName: "isAvailable",
      args: [label],
    }),
    client.readContract({
      address: ENSV2_ADDRESSES.ethRegistrar,
      abi: ethRegistrarAbi,
      functionName: "getRegisterPrice",
      args: [label, duration, paymentToken],
    }),
    client.readContract({
      address: paymentToken,
      abi: erc20MinimalAbi,
      functionName: "balanceOf",
      args: [wallet],
    }),
  ]);
  return { available, base: price[0], premium: price[1], total: price[0] + price[1], balance };
}

/**
 * Execute the plan. ONLY called with a wallet client — scripts construct
 * one exclusively when ENSETH_PRIVATE_KEY + ENSV2_RPC_URL are set.
 * Order: deployProxy → approve → commit → wait → register.
 */
export async function executeRegistrationPlan(
  wallet: WalletClient,
  client: Ensv2PublicClient,
  plan: RegistrationPlan,
): Promise<{ resolver: Address; txHashes: `0x${string}`[]; tokenId: bigint }> {
  if (!wallet.account) throw new Error("wallet client has no account");
  const owner = wallet.account.address;
  const txHashes: `0x${string}`[] = [];

  // 0. Deploy the resolver proxy (CREATE2 — no-op if the salt is spent).
  const deployHash = await wallet.writeContract({
    address: plan.resolverDeploy.to,
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [ENSV2_ADDRESSES.permissionedResolverImpl, plan.resolverDeploy.salt, plan.resolverDeploy.data],
    account: owner,
    chain: sepolia,
  });
  txHashes.push(deployHash);
  const deployReceipt = await client.waitForTransactionReceipt({ hash: deployHash });
  const deployed = deployReceipt.logs.find((log) =>
    log.address.toLowerCase() === ENSV2_ADDRESSES.verifiableFactory.toLowerCase(),
  );
  let resolver = plan.resolver;
  if (deployed) {
    // ProxyDeployed(address indexed sender, address proxyAddress, ...)
    resolver = `0x${deployed.data.slice(26, 66)}` as Address;
  }

  // 1. Approve the registrar for base + premium.
  const price = await client.readContract({
    address: ENSV2_ADDRESSES.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: "getRegisterPrice",
    args: [plan.label, ONE_YEAR, ENSV2_ADDRESSES.mockUsdc],
  });
  const total = price[0] + price[1];
  const approveHash = await wallet.writeContract({
    address: ENSV2_ADDRESSES.mockUsdc,
    abi: erc20MinimalAbi,
    functionName: "approve",
    args: [ENSV2_ADDRESSES.ethRegistrar, total],
    account: owner,
    chain: sepolia,
  });
  txHashes.push(approveHash);
  await client.waitForTransactionReceipt({ hash: approveHash });

  // 2. Commit (rebind the plan with the real resolver address).
  const commitment = makeCommitment({
    label: plan.label,
    owner,
    secret: plan.commit.secret,
    subregistry: `0x${"00".repeat(20)}` as Address,
    resolver,
    duration: ONE_YEAR,
    referrer: `0x${"00".repeat(32)}` as `0x${string}`,
  });
  const commitHash = await wallet.writeContract({
    address: ENSV2_ADDRESSES.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: "commit",
    args: [commitment],
    account: owner,
    chain: sepolia,
  });
  txHashes.push(commitHash);
  await client.waitForTransactionReceipt({ hash: commitHash });

  // 3. Wait out MIN_COMMITMENT_AGE.
  await sleep(plan.waitSeconds * 1000);

  // 4. Register.
  const registerHash = await wallet.writeContract({
    address: ENSV2_ADDRESSES.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: "register",
    args: [
      plan.label,
      owner,
      plan.commit.secret,
      `0x${"00".repeat(20)}`,
      resolver,
      ONE_YEAR,
      ENSV2_ADDRESSES.mockUsdc,
      `0x${"00".repeat(32)}`,
    ],
    account: owner,
    chain: sepolia,
  });
  txHashes.push(registerHash);
  const registerReceipt = await client.waitForTransactionReceipt({ hash: registerHash });
  const registered = registerReceipt.logs.find(
    (log) => log.address.toLowerCase() === ENSV2_ADDRESSES.ethRegistrar.toLowerCase(),
  );
  let tokenId = 0n;
  if (registered) {
    tokenId = BigInt(`0x${registered.data.slice(2, 66)}`);
  }

  return { resolver, txHashes, tokenId };
}

/**
 * Resolve the résumé back from ENSv2 via the UniversalResolverProxy.
 * Read-only.
 */
export async function resolveName(
  client: Ensv2PublicClient,
  name: string,
): Promise<Record<string, string>> {
  const node = namehash(name);
  const keys = [
    "com.bulwark.insured",
    "com.bulwark.driving",
    "com.bulwark.claims",
    "com.bulwark.alibi",
    "com.bulwark.backing",
    "com.bulwark.status",
    ENSV2_TEXT_KEYS.resume,
    ENSV2_TEXT_KEYS.chainhead,
  ];
  const out: Record<string, string> = {};
  const resolveAbi = parseAbi([
    "function resolve(bytes name, bytes data) returns (bytes result, address resolver)",
  ]);
  const textReturnAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
  for (const key of keys) {
    // Canonical path: UniversalResolverProxy.resolve(dnsName, text-calldata)
    // returns (abiEncodedResult, resolver). The inner result must be
    // decoded as text()'s own return (a string).
    try {
      const value = await client.readContract({
        address: ENSV2_ADDRESSES.universalResolverProxy,
        abi: resolveAbi,
        functionName: "resolve",
        args: [
          toHex(dnsEncode(name)),
          encodeFunctionData({
            abi: permissionedResolverAbi,
            functionName: "text",
            args: [node, key],
          }),
        ],
      });
      const [decoded] = decodeFunctionResult({
        abi: textReturnAbi,
        functionName: "text",
        data: value[0],
      });
      out[key] = decoded ?? "";
    } catch {
      out[key] = ""; // key absent or name unresolved — print, don't crash
    }
  }
  return out;
}

/** Minimal DNS packet encoding for the resolve() name argument (no dependency). */
export function dnsEncodeForTest(name: string): Uint8Array {
  return dnsEncode(name);
}

function dnsEncode(name: string): Uint8Array {
  const parts = name.split(".");
  const bytes: number[] = [];
  for (const part of parts) {
    const encoded = new TextEncoder().encode(part);
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return new Uint8Array(bytes);
}

/** Gate check: only construct a writer when both env keys exist. */
export function writerGate(env: Record<string, string | undefined>): {
  allowed: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!env["ENSETH_PRIVATE_KEY"]) missing.push("ENSETH_PRIVATE_KEY");
  if (!env["ENSV2_RPC_URL"]) missing.push("ENSV2_RPC_URL");
  return { allowed: missing.length === 0, missing };
}

export { createWalletClient };
