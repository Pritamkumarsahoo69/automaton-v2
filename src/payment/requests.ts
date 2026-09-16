/**
 * Payment Requests / Invoices
 *
 * Create payment requests, track status, and verify incoming Base USDC
 * payments via on-chain Transfer log matching. Replaces the unsafe
 * balance-delta detection with cryptographically verified receipts.
 */

import type { DatabaseType } from "../state/database.js";
import { ulid } from "ulid";
import type { Address } from "viem";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("payment.requests");

export type PaymentRequestStatus = "pending" | "paid" | "expired" | "cancelled";

export interface PaymentRequest {
  id: string;
  amountUsd: number;
  payer: string;
  reference: string;
  description: string;
  status: PaymentRequestStatus;
  txHash: string | null;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  paymentNotBeforeBlock: bigint | null;
}

export interface CreatePaymentRequestParams {
  amountUsd: number;
  payer: Address;
  reference?: string;
  description?: string;
  expiresInHours?: number;
  paymentNotBeforeBlock?: bigint;
}

export interface VerifiedPaymentReceipt {
  paymentRequestId: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  from: Address;
  to: Address;
  amountAtomic: bigint;
  verifiedAt: string;
}

export interface BaseUsdcLogClient {
  getBlockNumber(): Promise<bigint>;
  getTransferLogs(input: {
    recipient: Address;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Array<{
    transactionHash: `0x${string}`;
    logIndex: number;
    blockNumber: bigint;
    args: { from: Address; to: Address; value: bigint };
  }>>;
}

/**
 * Get the latest confirmed Base block number for a network.
 */
export async function getBaseBlockCheckpoint(
  network: "eip155:8453" | "eip155:84532",
): Promise<bigint> {
  const { createBaseUsdcLogClient } = await import("./usdc.js");
  const client = createBaseUsdcLogClient(network);
  return client.getBlockNumber();
}

/**
 * Create a new payment request in the database.
 */
export function createPaymentRequest(
  db: DatabaseType,
  params: CreatePaymentRequestParams,
): PaymentRequest {
  const id = ulid();
  const now = new Date().toISOString();
  const amountCents = Math.round(params.amountUsd * 100);
  const expiresAt = params.expiresInHours
    ? new Date(Date.now() + params.expiresInHours * 60 * 60 * 1000).toISOString()
    : null;
  const notBeforeBlock = params.paymentNotBeforeBlock ?? null;

  db.prepare(`
    INSERT INTO payment_requests (id, amount_cents, payer, reference, description, status, expires_at, payment_not_before_block)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    amountCents,
    params.payer,
    params.reference || null,
    params.description || null,
    expiresAt,
    notBeforeBlock ? notBeforeBlock.toString() : null,
  );

  logger.info(`Payment request created: ${id}, amount: $${params.amountUsd}, payer: ${params.payer}`);

  return {
    id,
    amountUsd: params.amountUsd,
    payer: params.payer,
    reference: params.reference || "",
    description: params.description || "",
    status: "pending",
    txHash: null,
    createdAt: now,
    expiresAt,
    paidAt: null,
    paymentNotBeforeBlock: notBeforeBlock ?? null,
  };
}

/**
 * List payment requests with optional filters.
 */
export function listPaymentRequests(
  db: DatabaseType,
  filters?: { status?: PaymentRequestStatus; payer?: string; reference?: string },
): PaymentRequest[] {
  let query = "SELECT * FROM payment_requests";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.payer) {
    conditions.push("payer = ?");
    params.push(filters.payer);
  }
  if (filters?.reference) {
    conditions.push("reference = ?");
    params.push(filters.reference);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY created_at DESC";

  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(deserializePaymentRequest);
}

/**
 * Get a single payment request by ID.
 */
export function getPaymentRequest(db: DatabaseType, id: string): PaymentRequest | undefined {
  const row = db.prepare("SELECT * FROM payment_requests WHERE id = ?").get(id) as any;
  return row ? deserializePaymentRequest(row) : undefined;
}

/**
 * Mark a payment request as paid with the transaction hash.
 * Kept for backward compatibility with non-verified paths.
 */
export function markPaymentRequestPaid(db: DatabaseType, id: string, txHash: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE payment_requests
    SET status = 'paid', tx_hash = ?, paid_at = ?
    WHERE id = ?
  `).run(txHash, now, id);

  logger.info(`Payment request ${id} marked as paid, tx: ${txHash}`);
}

/**
 * Mark a payment request as expired.
 */
export function expirePaymentRequest(db: DatabaseType, id: string): void {
  db.prepare(`UPDATE payment_requests SET status = 'expired' WHERE id = ?`).run(id);
}

/**
 * Mark a payment request as paid with a verified on-chain receipt.
 * Performs one atomic SQLite transaction:
 *   1. Ensure request is still pending
 *   2. Insert verification record (unique on tx_hash + log_index)
 *   3. Update request to 'paid' with real tx_hash
 *   4. Insert transfer_in ledger entry
 */
export function markPaymentRequestVerifiedPaid(
  db: DatabaseType,
  paymentRequestId: string,
  receipt: VerifiedPaymentReceipt,
): void {
  const txn = db.transaction(() => {
    // Ensure still pending
    const req = db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(paymentRequestId) as { status: string } | undefined;
    if (!req || req.status !== "pending") {
      throw new Error(`Payment request ${paymentRequestId} is not pending (status: ${req?.status ?? "not found"})`);
    }

    // Insert verification record (will fail on duplicate tx_hash+log_index)
    db.prepare(`
      INSERT INTO payment_verifications (payment_request_id, tx_hash, log_index, block_number, from_address, to_address, amount_atomic, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      receipt.paymentRequestId,
      receipt.txHash,
      receipt.logIndex,
      receipt.blockNumber.toString(),
      receipt.from,
      receipt.to,
      receipt.amountAtomic.toString(),
    );

    // Update request to paid
    db.prepare(`
      UPDATE payment_requests
      SET status = 'paid', tx_hash = ?, paid_at = ?
      WHERE id = ?
    `).run(receipt.txHash, receipt.verifiedAt, paymentRequestId);

    // Record in transactions ledger
    const amountCents = Math.round(parseFloat(receipt.amountAtomic.toString()) / 10_000);
    db.prepare(`
      INSERT OR REPLACE INTO transactions (id, type, amount_cents, balance_after_cents, description, created_at)
      VALUES (?, 'transfer_in', ?, ?, ?, datetime('now'))
    `).run(
      `pay_${receipt.paymentRequestId}`,
      amountCents,
      amountCents,
      `Verified Base USDC payment for ${receipt.paymentRequestId} from ${receipt.from}`,
    );
  });
  txn();
  logger.info(`Payment request ${paymentRequestId} verified paid via tx=${receipt.txHash}`);
}

/**
 * Look up a verified payment receipt for a payment request.
 */
export function getVerifiedPaymentReceipt(
  db: DatabaseType,
  paymentRequestId: string,
): VerifiedPaymentReceipt | undefined {
  const row = db.prepare(`
    SELECT pv.*, pr.amount_cents
    FROM payment_verifications pv
    JOIN payment_requests pr ON pv.payment_request_id = pr.id
    WHERE pv.payment_request_id = ?
  `).get(paymentRequestId) as any;
  if (!row) return undefined;
  return {
    paymentRequestId: row.payment_request_id,
    txHash: row.tx_hash as `0x${string}`,
    logIndex: row.log_index,
    blockNumber: BigInt(row.block_number),
    from: row.from_address as Address,
    to: row.to_address as Address,
    amountAtomic: BigInt(row.amount_atomic),
    verifiedAt: row.verified_at,
  };
}

/**
 * Scan on-chain Base USDC Transfer logs to find payments matching
 * pending payment requests. Only marks requests as paid when an
 * exact (payer, recipient, amount, block >= checkpoint, confirmations)
 * match is found.
 *
 * @param db - Database connection
 * @param input - Verification parameters
 * @returns Array of verified payment receipts
 */
export async function verifyPendingBaseUsdcPayments(
  db: DatabaseType,
  input: {
    recipient: Address;
    network: "eip155:8453" | "eip155:84532";
    requiredConfirmations: number;
    client?: BaseUsdcLogClient;
  },
): Promise<VerifiedPaymentReceipt[]> {
  const { recipient, network, requiredConfirmations, client: injectedClient } = input;
  const { createBaseUsdcLogClient, BASE_USDC_ADDRESSES } = await import("./usdc.js");

  const client = injectedClient ?? createBaseUsdcLogClient(network);
  const usdcAddress = BASE_USDC_ADDRESSES[network];

  // Fetch current block
  const latestBlock = await client.getBlockNumber();
  const safeToBlock = latestBlock - BigInt(requiredConfirmations) + 1n;

  if (safeToBlock < 0n) {
    return [];
  }

  // Load pending invoices with a block checkpoint
  const pendingInvoices = db.prepare(`
    SELECT id, amount_cents, payer, payment_not_before_block
    FROM payment_requests
    WHERE status = 'pending' AND payment_not_before_block IS NOT NULL
    ORDER BY created_at ASC
  `).all() as Array<{
    id: string;
    amount_cents: number;
    payer: string;
    payment_not_before_block: string;
  }>;

  if (pendingInvoices.length === 0) {
    return [];
  }

  // Determine scan range
  const fromBlock = pendingInvoices.reduce(
    (min, inv) => {
      const block = BigInt(inv.payment_not_before_block);
      return block < min ? block : min;
    },
    safeToBlock,
  );

  // Query Transfer logs
  const logs = await client.getTransferLogs({
    recipient,
    fromBlock,
    toBlock: safeToBlock,
  });

  // Index logs by (txHash, logIndex) for dedup
  const consumed = new Set<string>();
  // Check DB for already-verified logs
  const existing = db.prepare(`
    SELECT tx_hash, log_index FROM payment_verifications
  `).all() as Array<{ tx_hash: string; log_index: number }>;
  for (const ev of existing) {
    consumed.add(`${ev.tx_hash}:${ev.log_index}`);
  }

  const receipts: VerifiedPaymentReceipt[] = [];
  let remainingDelta = 0n;
  let invoiceIdx = 0;

  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (consumed.has(key)) continue;

    // Skip logs that are not yet confirmed (above safeToBlock)
    if (log.blockNumber > safeToBlock) continue;

    const fromLower = log.args.from.toLowerCase() as Address;
    const toLower = log.args.to.toLowerCase() as Address;

    // Process invoices in FIFO order
    while (invoiceIdx < pendingInvoices.length) {
      const inv = pendingInvoices[invoiceIdx];
      const invAmountAtomic = BigInt(inv.amount_cents) * 10_000n; // cents to atomic (6 decimals)

      // Check if this log can satisfy this invoice
      const matches =
        fromLower === inv.payer.toLowerCase() &&
        toLower === recipient.toLowerCase() &&
        log.args.value === invAmountAtomic &&
        log.blockNumber >= BigInt(inv.payment_not_before_block);

      if (!matches) break; // This log doesn't match; next invoice might match a different log

      // Match found
      const receipt: VerifiedPaymentReceipt = {
        paymentRequestId: inv.id,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        from: fromLower,
        to: toLower,
        amountAtomic: invAmountAtomic,
        verifiedAt: new Date().toISOString(),
      };
      receipts.push(receipt);
      consumed.add(key);
      invoiceIdx++;
      break; // Move to next log
    }
  }

  // Mark all matched requests as paid
  for (const receipt of receipts) {
    try {
      markPaymentRequestVerifiedPaid(db, receipt.paymentRequestId, receipt);
    } catch (err) {
      logger.warn(`Failed to mark payment request ${receipt.paymentRequestId} as paid: ${err}`);
    }
  }

  if (receipts.length > 0) {
    logger.info(`Verified ${receipts.length} Base USDC payment(s)`);
  }
  return receipts;
}

/**
 * Get total pending payment requests amount.
 */
export function getTotalPendingAmount(db: DatabaseType): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) as total FROM payment_requests WHERE status = 'pending'"
  ).get() as { total: number };
  return row.total / 100;
}

function deserializePaymentRequest(row: any): PaymentRequest {
  return {
    id: row.id,
    amountUsd: row.amount_cents / 100,
    payer: row.payer,
    reference: row.reference || "",
    description: row.description || "",
    status: row.status as PaymentRequestStatus,
    txHash: row.tx_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    paymentNotBeforeBlock: row.payment_not_before_block ? BigInt(row.payment_not_before_block) : null,
  };
}