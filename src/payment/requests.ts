/**
 * Payment Requests / Invoices
 *
 * Create payment requests, track status, detect incoming payments.
 */

import type { DatabaseType } from "../state/database.js";
import { ulid } from "ulid";
import { getUsdcBalance } from "../conway/x402.js";
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
}

export interface CreatePaymentRequestParams {
  amountUsd: number;
  payer: Address;
  reference?: string;
  description?: string;
  expiresInHours?: number;
}

// Schema for payment_requests table
export const PAYMENT_REQUESTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    amount_cents INTEGER NOT NULL,
    payer TEXT NOT NULL,
    reference TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired','cancelled')),
    tx_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    paid_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_payer ON payment_requests(payer);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_reference ON payment_requests(reference);
`;

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

  db.prepare(`
    INSERT INTO payment_requests (id, amount_cents, payer, reference, description, status, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    amountCents,
    params.payer,
    params.reference || null,
    params.description || null,
    expiresAt,
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
 * Detect incoming payments by comparing the current USDC balance against
 * the last known balance (stored in kv 'last_usdc_balance').
 *
 * When the balance increases, match the delta against pending payment requests
 * FIFO (oldest first) and mark matched requests as paid.
 *
 * Detection is best-effort: an agent cannot cryptographically know *who* paid
 * on a plain USDC transfer, so we attribute increases to the oldest open
 * invoice(s). Expired requests are marked as such on each pass.
 */
export async function detectIncomingPayments(
  db: DatabaseType,
  currentBalanceUsd: number,
): Promise<PaymentRequest[]> {
  const pending = listPaymentRequests(db, { status: "pending" });

  // Always persist the current balance so the next pass has a baseline.
  const persistBalance = () => {
    db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('last_usdc_balance', ?, datetime('now'))",
    ).run(currentBalanceUsd.toFixed(6));
  };

  if (pending.length === 0) {
    persistBalance();
    return [];
  }

  // Expire stale requests first.
  for (const request of pending) {
    if (request.expiresAt && new Date(request.expiresAt) < new Date()) {
      expirePaymentRequest(db, request.id);
    }
  }

  // Previous balance baseline.
  const prevRow = db
    .prepare("SELECT value FROM kv WHERE key = 'last_usdc_balance'")
    .get() as { value: string } | undefined;
  const previousBalance = prevRow ? parseFloat(prevRow.value) : currentBalanceUsd;

  const deltaUsd = currentBalanceUsd - previousBalance;
  if (deltaUsd < 0.005) {
    // No meaningful increase. Persist baseline and return.
    persistBalance();
    return [];
  }

  // Match the delta against open (non-expired) requests FIFO.
  const open = listPaymentRequests(db, { status: "pending" }).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  let remaining = deltaUsd;
  const paid: PaymentRequest[] = [];

  for (const request of open) {
    if (remaining < request.amountUsd - 0.01) {
      break; // nearest payment request can't be covered by this delta
    }
    const pseudoTx = `balance:${request.id}:${Date.now()}`;
    markPaymentRequestPaid(db, request.id, pseudoTx);
    paid.push({ ...request, status: "paid", txHash: pseudoTx, paidAt: new Date().toISOString() });
    remaining -= request.amountUsd;

    // Record the inflow in the transactions ledger.
    const txnId = `pay_${request.id}`;
    db.prepare(
      `INSERT OR REPLACE INTO transactions (id, type, amount_cents, balance_after_cents, description, created_at)
       VALUES (?, 'transfer_in', ?, ?, ?, datetime('now'))`,
    ).run(
      txnId,
      Math.round(request.amountUsd * 100),
      Math.round(currentBalanceUsd * 100),
      `Incoming payment for ${request.reference || request.id} from ${request.payer}`,
    );
  }

  persistBalance();

  if (paid.length > 0) {
    logger.info(`Detected ${paid.length} incoming payment(s): ${paid.map((p) => `$${p.amountUsd}`).join(", ")}`);
  }
  return paid;
}

/**
 * Get total pending payment requests amount.
 */
export function getTotalPendingAmount(db: DatabaseType): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) as total FROM payment_requests WHERE status = 'pending'"
  ).get() as { total: number };
  return row.total / 100; // Convert cents to dollars
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
  };
}