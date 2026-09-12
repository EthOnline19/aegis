import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Address,
  type Log,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildRegistrationPlan,
  dnsEncodeForTest,
  ENSV2_ADDRESSES,
  ENSV2_TEXT_KEYS,
  executeRegistrationPlan,
  makeCommitment,
  renderForChain,
  resolverProxySalt,
  verifiableFactoryAbi,
  writerGate,
  type Ensv2PublicClient,
} from "../src/ensv2.ts";
import { buildResume, type ResumeInput } from "../src/resume.ts";

const OWNER = "0xB30553e2f132126B951D3a6AD4E07EbAa5523b6E" as const;
const SECRET = "0x" + "ab".repeat(32) as `0x${string}`;
const CHAIN_HEAD = "0x" + "cd".repeat(32) as `0x${string}`;

const DEMO: ResumeInput = {
  policy: { version: 4, capUsd: 2500, poolHealthy: true },
  driving: { cleanDays: 179, score: 94, premiumMultiplier: 0.72 },
  claims: { covered: 1, attempted: 1, payoutsUsd: [135] },
  alibi: { installed: true, instructionChainLive: true },
  backing: { worldIdVerified: true },
  status: "ACTIVE",
};

describe("buildRegistrationPlan", () => {
  const plan = buildRegistrationPlan({
    label: "repayd",
    owner: OWNER,
    secret: SECRET,
    resume: buildResume(DEMO),
    chainHead: CHAIN_HEAD,
  });

  it("plans a 4-tx flow: deployProxy → approve → commit → register", () => {
    expect(plan.name).toBe("repayd.eth");
    expect(plan.resolverDeploy.to).toBe(ENSV2_ADDRESSES.verifiableFactory);
    expect(plan.approve.spender).toBe(ENSV2_ADDRESSES.ethRegistrar);
    expect(plan.commit.to).toBe(ENSV2_ADDRESSES.ethRegistrar);
    expect(plan.register.to).toBe(ENSV2_ADDRESSES.ethRegistrar);
    expect(plan.waitSeconds).toBe(60);
  });

  it("bakes the résumé + chainhead text records into the resolver init setters", () => {
    expect(plan.textRecords[ENSV2_TEXT_KEYS.resume]).toContain("179-day clean streak");
    expect(plan.textRecords[ENSV2_TEXT_KEYS.resume]).toContain("World-ID verified human");
    expect(plan.textRecords[ENSV2_TEXT_KEYS.chainhead]).toBe(CHAIN_HEAD);
    // per-field keys also present
    expect(plan.textRecords["com.bulwark.insured"]).toContain("policy v4");
    expect(plan.resolverDeploy.data).toMatch(/^0x[0-9a-f]+$/);
  });

  it("binds all 7 params in the commitment (anti-frontrun)", () => {
    const again = makeCommitment({
      label: "repayd",
      owner: OWNER,
      secret: SECRET,
      subregistry: `0x${"00".repeat(20)}`,
      resolver: plan.resolver,
      duration: 60n * 60n * 24n * 365n,
      referrer: `0x${"00".repeat(32)}`,
    });
    expect(plan.commit.commitment).toBe(again);
    // different label → different commitment
    const other = makeCommitment({
      label: "atlasrepayd",
      owner: OWNER,
      secret: SECRET,
      subregistry: `0x${"00".repeat(20)}`,
      resolver: plan.resolver,
      duration: 60n * 60n * 24n * 365n,
      referrer: `0x${"00".repeat(32)}`,
    });
    expect(other).not.toBe(plan.commit.commitment);
  });

  it("resolver proxy salt is deterministic per owner", () => {
    expect(resolverProxySalt(OWNER)).toBe(resolverProxySalt(OWNER));
    expect(resolverProxySalt(OWNER)).not.toBe(resolverProxySalt(`0x${"11".repeat(20)}`));
  });
});

describe("writer gate", () => {
  it("blocks writes unless both env keys are set", () => {
    expect(writerGate({})).toEqual({
      allowed: false,
      missing: ["ENSETH_PRIVATE_KEY", "ENSV2_RPC_URL"],
    });
    expect(writerGate({ ENSETH_PRIVATE_KEY: "0xabc" })).toEqual({
      allowed: false,
      missing: ["ENSV2_RPC_URL"],
    });
    expect(
      writerGate({ ENSETH_PRIVATE_KEY: "0xabc", ENSV2_RPC_URL: "https://sepolia" }),
    ).toEqual({ allowed: true, missing: [] });
  });
});

describe("renderForChain", () => {
  it("renders the §13 block with the COMPUTED label riding the DRIVING line", () => {
    const block = renderForChain(buildResume(DEMO));
    expect(block.split("\n").map((l) => l.split(":")[0])).toEqual([
      "INSURED",
      "DRIVING",
      "CLAIMS",
      "ALIBI SDK",
      "BACKING",
      "STATUS",
    ]);
    expect(block).toContain("premium 0.72x [COMPUTED]");
  });
});

describe("dnsEncodeForTest", () => {
  it("encodes repayd.eth as wire-format DNS labels", () => {
    const bytes = dnsEncodeForTest("repayd.eth");
    expect(Array.from(bytes)).toEqual([
      6, ...[...repaydBytes()], 3, ...[...ethBytes()], 0,
    ]);
  });
});

function repaydBytes(): Uint8Array {
  return new TextEncoder().encode("repayd");
}
function ethBytes(): Uint8Array {
  return new TextEncoder().encode("eth");
}

// ------------------------------------------------------------------ //
//   executeRegistrationPlan — the nested-deployProxy live-run bug      //
// ------------------------------------------------------------------ //

/**
 * The bug that killed the first live run: executeRegistrationPlan
 * re-encoded plan.resolverDeploy.data (already deployProxy calldata) as
 * the `data` argument of a SECOND deployProxy call. The factory then ran
 * the nested bytes as proxy init-code → eth_estimateGas reverted.
 * These tests pin: the deploy tx carries plan.resolverDeploy.data
 * VERBATIM (init args = initialize(...), not a nested deployProxy),
 * every sent tx lands in txHashes, and a spent CREATE2 salt skips the
 * deploy broadcast on re-runs.
 */
describe("executeRegistrationPlan", () => {
  const PK = `0x${"11".repeat(32)}` as `0x${string}`;
  const ACCOUNT = privateKeyToAccount(PK);
  const PROXY = "0x2a63444cd961e4284e60b0314f58c707a8c86dAC" as Address;
  const DEPLOYED_TOPIC = keccak256(
    stringToHex("ProxyDeployed(address,address,uint256,address)"),
  );
  const INIT_SELECTOR = "0x7058b559"; // initialize(address,uint256,bytes[])

  const plan = buildRegistrationPlan({
    label: "repayd",
    owner: ACCOUNT.address,
    secret: SECRET,
    resume: buildResume(DEMO),
    chainHead: CHAIN_HEAD,
  });
  // No 60s sleep in tests.
  const fastPlan = { ...plan, waitSeconds: 0 };

  function proxyDeployedLog(salt: bigint): Log {
    return {
      address: ENSV2_ADDRESSES.verifiableFactory,
      topics: [
        DEPLOYED_TOPIC,
        encodeAbiParameters([{ type: "address" }], [ACCOUNT.address]),
      ],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "address" }],
        [PROXY, salt, ENSV2_ADDRESSES.permissionedResolverImpl],
      ),
    } as unknown as Log;
  }

  function nameRegisteredLog(tokenId: bigint): Log {
    return {
      address: ENSV2_ADDRESSES.ethRegistrar,
      topics: [
        keccak256(
          stringToHex(
            "NameRegistered(uint256,string,address,address,address,uint64,address,bytes32,uint256,uint256)",
          ),
        ),
      ],
      data: encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "string" },
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "uint64" },
          { type: "address" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [
          tokenId,
          "repayd",
          ACCOUNT.address,
          `0x${"00".repeat(20)}` as Address,
          PROXY,
          31_536_000n,
          ENSV2_ADDRESSES.mockUsdc,
          `0x${"00".repeat(32)}` as `0x${string}`,
          8_000_021n,
          0n,
        ],
      ),
    } as unknown as Log;
  }

  interface Sent {
    to: Address;
    data: `0x${string}`;
    hash: `0x${string}`;
  }

  /** Wallet whose signTransaction records the raw tx instead of signing. */
  function makeWallet(sent: Sent[]) {
    return {
      account: {
        ...ACCOUNT,
        signTransaction: async (tx: { to: Address; data: `0x${string}` }) => {
          const hash = keccak256(
            stringToHex(`${sent.length}:${tx.to}:${tx.data}`),
          );
          sent.push({ to: tx.to, data: tx.data, hash });
          return hash; // stand-in serialized payload
        },
      },
    } as unknown as WalletClient;
  }

  function makeClient(sent: Sent[], priorDeployLogs: Log[]) {
    return {
      readContract: async () => [8000021n, 0n], // getRegisterPrice
      getTransactionCount: async () => 3n,
      request: async (args: { method: string }) => {
        if (args.method === "eth_estimateGas") return "0x5208" as const;
        if (args.method === "eth_getLogs") return priorDeployLogs;
        throw new Error(`unexpected rpc ${args.method}`);
      },
      sendRawTransaction: async (args: { serializedTransaction: `0x${string}` }) =>
        // hash is the stand-in payload itself (see signTransaction above)
        args.serializedTransaction,
      waitForTransactionReceipt: async (args: { hash: `0x${string}` }) => {
        const last = sent.find((s) => s.hash === args.hash)!;
        const isFactory = last.to === ENSV2_ADDRESSES.verifiableFactory;
        const isRegister =
          last.to === ENSV2_ADDRESSES.ethRegistrar &&
          last.data.length > 400; // register(..) beats commit(bytes32)
        return {
          status: "success" as const,
          transactionHash: args.hash,
          logs: isFactory
            ? [proxyDeployedLog(plan.resolverDeploy.salt)]
            : isRegister
              ? [nameRegisteredLog(7n)]
              : [],
        };
      },
    };
  }

  it("sends deployProxy calldata VERBATIM — not nested in a second deployProxy", () => {
    // assert on the plan artifact itself: data must decode as ONE
    // deployProxy whose init argument is initialize(...) directly.
    const outer = decodeFunctionData({
      abi: verifiableFactoryAbi,
      data: plan.resolverDeploy.data,
    });
    expect(outer.functionName).toBe("deployProxy");
    expect((outer.args[0] as string).toLowerCase()).toBe(ENSV2_ADDRESSES.permissionedResolverImpl.toLowerCase());
    expect(outer.args[1]).toBe(plan.resolverDeploy.salt);
    expect((outer.args[2] as `0x${string}`).slice(0, 10)).toBe(INIT_SELECTOR);
  });

  it("executes deploy → approve → commit → register with verbatim deploy data", async () => {
    const sent: Sent[] = [];
    const wallet = makeWallet(sent);
    const client = makeClient(sent, []) as unknown as Ensv2PublicClient;
    const result = await executeRegistrationPlan(wallet, client, fastPlan);

    expect(sent.map((s) => s.to)).toEqual([
      ENSV2_ADDRESSES.verifiableFactory,
      ENSV2_ADDRESSES.mockUsdc,
      ENSV2_ADDRESSES.ethRegistrar,
      ENSV2_ADDRESSES.ethRegistrar,
    ]);
    // THE regression: first tx data === plan.resolverDeploy.data exactly.
    expect(sent[0]!.data).toBe(plan.resolverDeploy.data);
    // every broadcast recorded, in order
    expect(result.txHashes).toEqual(sent.map((s) => s.hash));
    expect(result.resolver).toBe(PROXY); // from ProxyDeployed
    expect(result.tokenId).toBe(7n); // from NameRegistered
  });

  it("skips the deploy broadcast when this sender's salt is already spent", async () => {
    const sent: Sent[] = [];
    const wallet = makeWallet(sent);
    const client = makeClient(sent, [proxyDeployedLog(plan.resolverDeploy.salt)]) as unknown as Ensv2PublicClient;
    const result = await executeRegistrationPlan(wallet, client, fastPlan);

    expect(sent.map((s) => s.to)).toEqual([
      ENSV2_ADDRESSES.mockUsdc,
      ENSV2_ADDRESSES.ethRegistrar,
      ENSV2_ADDRESSES.ethRegistrar,
    ]);
    expect(result.resolver).toBe(PROXY); // recovered from history logs
    expect(result.txHashes).toHaveLength(3);
  });
});
