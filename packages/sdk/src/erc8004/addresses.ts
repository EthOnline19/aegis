/**
 * ERC-8004 registry addresses — single source of truth for every TS
 * consumer (SDK, orchestrator, dashboard). Arc-first, keyed by chainId;
 * NO addresses are hardcoded anywhere else. BULWARK contracts never
 * reference these (see docs/ERC8004_DESIGN.md §4).
 *
 * All three registries are the canonical ERC-8004 CREATE2 deployments at
 * their well-known addresses (deterministic across chains), v2.0.0,
 * cross-linked (each exposes getIdentityRegistry() and friends), verified
 * live on Arc testnet via eth_getCode + calls (Step 1).
 */

/** Arc testnet (Circle's Arc public testnet). */
export const ARC_TESTNET_CHAIN_ID = 5_042_002 as const;

/** Canonical ERC-8004 registry addresses (same on every supported chain). */
export const ERC8004_ADDRESSES = {
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const;

/** Per-chain registry bundle. Arc testnet is the only live deployment. */
export const ERC8004_DEPLOYMENTS: Record<number, typeof ERC8004_ADDRESSES> = {
  [ARC_TESTNET_CHAIN_ID]: ERC8004_ADDRESSES,
};

/**
 * Resolve the registry set for a chain. Throws on unsupported chains —
 * posting to a registry we have not verified (Step 1) must fail loudly,
 * never silently target a lookalike deployment.
 */
export function erc8004ForChain(chainId: number): typeof ERC8004_ADDRESSES {
  const deployed = ERC8004_DEPLOYMENTS[chainId];
  if (!deployed) {
    throw new Error(`no ERC-8004 registries for chainId ${chainId} (supported: ${Object.keys(ERC8004_DEPLOYMENTS).join(", ")})`);
  }
  return deployed;
}
