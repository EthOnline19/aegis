/**
 * REPAYD x402 HCS Audit Trail — payment receipts on Hedera Consensus Service.
 *
 * After the Blocky402 facilitator settles a payment, the service submits a
 * JSON receipt memo to an HCS topic. Every memo is a verifiable, ordered,
 * timestamped audit record of who paid for what — queryable by anyone on
 * HashScan or any HCS mirror node.
 *
 * Gated: requires HEDERA_SERVICE_KEY (+ HEDERA_SERVICE_ID). Without the key
 * the recorder runs in dry-run mode: it logs the exact memo it would submit
 * and returns a synthetic "dry-run" result. The Hiero SDK import is static
 * (declared dependency); in dry-run mode the operator client is simply never
 * constructed.
 */

import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";

export interface ReceiptMemo {
  readonly kind: "repayd.x402-receipt";
  /** Hedera transaction id of the settled payment (from the facilitator). */
  readonly tx: string;
  readonly network: string;
  readonly endpoint: string;
  /** Price actually charged, tinybars. */
  readonly price: string;
  /** ERC-8004 agent id of the payer, when identified. */
  readonly agentId: string | null;
  readonly identityVerified: boolean;
  readonly ts: number;
}

export interface ReceiptResult {
  readonly submitted: boolean;
  readonly dryRun: boolean;
  /** The HCS topic the memo went to (or would go to). */
  readonly topicId: string | null;
  /** HCS submit transaction id, when submitted. */
  readonly submitTx: string | null;
}

export interface ReceiptRecorder {
  record(memo: ReceiptMemo): Promise<ReceiptResult>;
}

export function buildReceiptMemo(input: {
  tx: string;
  network: string;
  endpoint: string;
  price: string;
  agentId: string | null;
  identityVerified: boolean;
  now?: number;
}): ReceiptMemo {
  return {
    kind: "repayd.x402-receipt",
    tx: input.tx,
    network: input.network,
    endpoint: input.endpoint,
    price: input.price,
    agentId: input.agentId,
    identityVerified: input.identityVerified,
    ts: input.now ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Dry-run recorder — the default. Logs the memo, claims nothing.
 */
export function dryRunRecorder(topicId: string | null): ReceiptRecorder {
  return {
    async record(memo: ReceiptMemo): Promise<ReceiptResult> {
      console.log(
        `[hcs:dry-run] would submit to topic ${topicId ?? "<would auto-create>"}: ${JSON.stringify(memo)}`,
      );
      return { submitted: false, dryRun: true, topicId, submitTx: null };
    },
  };
}

/**
 * Live recorder — submits the memo to HCS on Hedera testnet.
 * Auto-creates the audit topic on first use when no topic id is configured.
 */
export async function liveRecorder(
  serviceId: string,
  serviceKey: string,
  topicId: string | null,
): Promise<ReceiptRecorder> {
  const client = Client.forTestnet().setOperator(
    serviceId,
    PrivateKey.fromStringECDSA(serviceKey),
  );

  let topic = topicId;
  if (!topic) {
    const tx = await new TopicCreateTransaction()
      .setTopicMemo("REPAYD x402 payment receipts — verifiable audit trail")
      .execute(client);
    const receipt = await tx.getReceipt(client);
    topic = receipt.topicId?.toString() ?? null;
    console.log(`[hcs] created audit topic ${topic} (set HEDERA_RECEIPT_TOPIC_ID=${topic} to reuse)`);
  }
  const finalTopic = topic;

  return {
    async record(memo: ReceiptMemo): Promise<ReceiptResult> {
      if (!finalTopic) throw new Error("HCS topic unavailable");
      const submit = await new TopicMessageSubmitTransaction()
        .setTopicId(finalTopic)
        .setMessage(JSON.stringify(memo))
        .execute(client);
      await submit.getReceipt(client);
      console.log(`[hcs] receipt memo submitted: ${submit.transactionId?.toString()}`);
      return {
        submitted: true,
        dryRun: false,
        topicId: finalTopic,
        submitTx: submit.transactionId?.toString() ?? null,
      };
    },
  };
}
