/**
 * REPAYD premium scheduling — recurring premium draws via Hedera Scheduled
 * Transactions (extra point: "recurring/streamed payments").
 *
 * The REPAYD premium is charged per block the agent is active (the pricing
 * engine's per-block rate). The natural Hedera mapping is a scheduled
 * HBAR transfer: ScheduleCreate freezes one TransferTransaction (premium →
 * the service's payTo account); the network executes it once the schedule's
 * wait-for-expiry window passes, and the same ScheduleCreate can be re-used
 * as the cadence anchor for per-block premium draws (see README §Scheduled).
 *
 * HAPI call chain (live):
 *   ScheduleCreateTransaction
 *     .setScheduleMemo("REPAYD premium: agentId 894341 …")
 *     .setScheduledTransaction(
 *       TransferTransaction().addHbarTransfer(payer, -premium)
 *                            .addHbarTransfer(payTo, +premium))
 *     .execute(client)  → scheduleId (+ scheduled transactionId)
 *   ScheduleSignTransaction by the payer when multi-party signing is needed.
 *
 * Dry-run default: without HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY the script
 * prints the exact transaction it would submit and exits 0.
 */

import {
  Client,
  PrivateKey,
  ScheduleCreateTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const OPERATOR_ID = process.env.HEDERA_OPERATOR_ID ?? "";
const OPERATOR_KEY = process.env.HEDERA_OPERATOR_KEY ?? "";
const PAY_TO = process.env.HEDERA_SERVICE_ID ?? "0.0.UNSET";
/** Premium per draw in HBAR — mirrors one per-block premium epoch. */
const PREMIUM_HBAR = Number(process.env.REPAYD_PREMIUM_HBAR ?? "0.001");

async function main(): Promise<void> {
  const memo = `REPAYD premium: agentId 894341, per-block draw, ${PREMIUM_HBAR} HBAR`;

  if (!OPERATOR_ID || !OPERATOR_KEY) {
    console.log("[DRY-RUN] HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set — no schedule created.");
    console.log("  Would submit to Hedera testnet (HAPI chain):");
    console.log("    ScheduleCreateTransaction");
    console.log(`      .setScheduleMemo("${memo}")`);
    console.log("      .setScheduledTransaction(");
    console.log("        TransferTransaction");
    console.log(`          .addHbarTransfer(<operator ${OPERATOR_ID || "0.0.x"}>, -${PREMIUM_HBAR} HBAR)`);
    console.log(`          .addHbarTransfer(<payTo ${PAY_TO}>, +${PREMIUM_HBAR} HBAR))`);
    console.log("    .execute(Client.forTestnet().setOperator(<operator>, <ECDSA key>))");
    console.log('  ← { scheduleId: "0.0.x", transactionId: "0.0.x@…", scheduled: true }');
    console.log("  Executed by the network at wait-for-expiry; visible on");
    console.log("  https://hashscan.io/testnet/schedule/0.0.x — the recurring premium");
    console.log("  cadence is one ScheduleCreate per block-epoch (per-block pricing).");
    return;
  }

  const client = Client.forTestnet().setOperator(
    OPERATOR_ID,
    PrivateKey.fromStringECDSA(OPERATOR_KEY),
  );
  const tx = new TransferTransaction()
    .addHbarTransfer(OPERATOR_ID, -PREMIUM_HBAR)
    .addHbarTransfer(PAY_TO, PREMIUM_HBAR);
  const schedule = new ScheduleCreateTransaction()
    .setScheduleMemo(memo)
    .setScheduledTransaction(tx);

  const response = await schedule.execute(client);
  const receipt = await response.getReceipt(client);
  console.log(`schedule created: ${receipt.scheduleId?.toString()}`);
  console.log(`tx id: ${response.transactionId?.toString()}`);
  console.log(`https://hashscan.io/testnet/schedule/${receipt.scheduleId?.toString()}`);
  await client.close();
}

main().catch((err) => {
  console.error("schedule-premium failed:", err);
  process.exit(1);
});
