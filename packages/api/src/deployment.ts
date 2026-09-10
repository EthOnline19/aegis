/**
 * Shared loader for forge-deployed stacks (contracts/script/Deploy.s.sol →
 * contracts/deployments/<chainId>.json).
 *
 * Tooling (demo, orchestrator, dashboards) consumes PRE-DEPLOYED state via
 * this file instead of redeploying — the forge script is the single deploy
 * path; everything downstream is address-consumption only.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Deployed contract addresses written by Deploy.s.sol. */
export interface DeploymentContracts {
  readonly usdc: `0x${string}`;
  readonly policyRegistry: `0x${string}`;
  readonly blocklist: `0x${string}`;
  readonly verdicts: `0x${string}`;
  readonly mutualPool: `0x${string}`;
  readonly guardAccount: `0x${string}`;
}

/** Canonical ERC-8004 registries (recorded from day one, no on-chain wiring). */
export interface DeploymentErc8004 {
  readonly identity: `0x${string}`;
  readonly reputation: `0x${string}`;
  readonly validation: `0x${string}`;
  readonly note: string;
}

export interface DeploymentRecord {
  readonly chainId: number;
  readonly chainIdAnchor: string;
  readonly contracts: DeploymentContracts;
  readonly actors: {
    readonly deployer: `0x${string}`;
    readonly amaraPolicyOwner: `0x${string}`;
    readonly agentSessionKey: `0x${string}`;
    readonly watcher: `0x${string}`;
    readonly raviJunior: `0x${string}`;
    readonly seniorLP: `0x${string}`;
  };
  readonly erc8004: DeploymentErc8004;
  readonly seed: {
    readonly guardBacking: string;
    readonly juniorDeposit: string;
    readonly seniorDeposit: string;
    readonly mockUsdc: boolean;
  };
}

function repoRoot(): string {
  // packages/<x>/src/... → repo root is three levels up from this file.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Load + minimally validate contracts/deployments/<chainId>.json. */
export async function loadDeployment(chainId?: number): Promise<DeploymentRecord> {
  const root = repoRoot();
  let id = chainId;
  if (id === undefined) {
    // Env override, else default to the local anvil artifact.
    const env = process.env.DEPLOYMENT_CHAIN_ID ?? process.env.ARC_TESTNET_CHAIN_ID;
    id = env ? Number(env) : 31337;
  }
  const path = resolve(root, "contracts/deployments", `${id}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no deployment record at ${path} — run: cd contracts && forge script script/Deploy.s.sol ` +
        `--rpc-url <rpc> --broadcast (writes deployments/${id}.json)`,
    );
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as DeploymentRecord;
  const c = raw.contracts;
  for (const [k, v] of Object.entries(c)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`deployments/${id}.json: contracts.${k} invalid address "${v}"`);
  }
  if (raw.chainId !== id) throw new Error(`deployments/${id}.json: chainId ${raw.chainId} != requested ${id}`);
  return raw;
}
