/**
 * resolve.ts — read the REPAYD insurance résumé back from ENSv2.
 *
 * One lookup prices trust in the machine (plan §13/§35):
 *
 *   bun run scripts/resolve.ts [name]     # default: repayd.eth
 *
 * Read-only: no env keys, no writes. Resolves via the ENSv2
 * UniversalResolverProxy and prints every com.bulwark.* text record with
 * its provenance label. If the name is not yet registered, prints the
 * blocker instead of crashing.
 */

import { createEnsv2PublicClient, ENSV2_ADDRESSES, resolveName } from "../src/ensv2.ts";
import { fromEnsTextRecords, parseEnsTextValue, ENS_TEXT_KEY, FIELD_LABEL, FIELD_ORDER } from "../src/resume.ts";

const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

async function main(): Promise<void> {
  const name = process.argv[2] ?? "repayd.eth";
  const rpcUrl = process.env["ENSV2_RPC_URL"] ?? DEFAULT_RPC;
  const client = createEnsv2PublicClient(rpcUrl);

  console.log(`
━━━ resolve ${name} ━━━
  universal resolver: ${ENSV2_ADDRESSES.universalResolverProxy}
  rpc:                ${rpcUrl}
`);

  const records = await resolveName(client, name);

  // Full block first (com.bulwark.resume), then per-field records.
  const block = records["com.bulwark.resume"];
  const chainHead = records["com.bulwark.chainhead"];
  if (block) {
    console.log("  INSURANCE RÉSUMÉ (com.bulwark.resume):");
    console.log(
      block
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
  } else {
    console.log("  (no com.bulwark.resume record — name not registered or resolver not set)");
  }
  if (chainHead) {
    console.log(`\n  ALIBI CHAIN HEAD (com.bulwark.chainhead): ${chainHead}`);
  }

  const fields = fromEnsTextRecords(records);
  const present = FIELD_ORDER.filter((k) => fields[k] !== undefined);
  if (present.length > 0) {
    console.log("\n  PER-FIELD RECORDS (com.bulwark.*):");
    for (const k of present) {
      const f = fields[k]!;
      console.log(`    ${FIELD_LABEL[k].padEnd(9)} ${f.text} [${f.provenance}]`);
    }
  }

  const missing = FIELD_ORDER.filter((k) => fields[k] === undefined);
  if (missing.length === FIELD_ORDER.length) {
    console.log(`
  ⚠ Could not resolve any REPAYD records for "${name}".
    Most likely: the name is not registered yet on ENSv2 Sepolia
    (run scripts/register.ts — dry-run by default), or the resolver
    proxy has no com.bulwark.* text records.`);
    process.exit(1);
  }
}

// parseEnsTextValue re-exported for consumers that import this module.
export { parseEnsTextValue, ENS_TEXT_KEY };

main().catch((err: unknown) => {
  console.error(`  resolve failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
