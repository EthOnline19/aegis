import { clients, deployProtocol, AGENT_KEY } from "/mnt/d/aegis/packages/demo/src/protocol.ts";
const c = clients();
const AMARA = (await import("viem/accounts")).privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const RAVI = (await import("viem/accounts")).privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const SENIOR = (await import("viem/accounts")).privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const p = await deployProtocol(c, { amara: AMARA, ravi: RAVI, senior: SENIOR });
// Create one pending hold (hold 1) via agent key.
await c.agent.writeContract({
  address: p.guard.address,
  abi: (await import("/mnt/d/aegis/contracts/out/GuardAccount.sol/GuardAccount.json")).default.abi,
  functionName: "propose",
  args: [p.usdc.address, "0x55405807c2766d2cb3724d671cc6c30458de6501", 150000000n],
  account: c.agent.account,
  chain: c.agent.chain,
});
const policyHash = await p.registry.read.policyHashAt([p.policy.agent, 1n]);
console.log("VERDICTS_ADDR=" + p.verdicts.address);
console.log("AGENT_ADDR=" + p.policy.agent);
console.log("POLICY_HASH=" + policyHash);
