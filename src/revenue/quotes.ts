/**
 * Revenue Job Quoting
 *
 * Converts a draft job into a quoted invoice with a linked Base USDC
 * payment request and a block checkpoint for later verification.
 */

import type { DatabaseType } from "../state/database.js";
import type { Address } from "viem";
import { createLogger } from "../observability/logger.js";
import { getRevenueJob, transitionRevenueJob } from "./jobs.js";
import type { RevenueJob, RevenuePolicy } from "./types.js";
import { createPaymentRequest } from "../payment/requests.js";
import type { PaymentRequest } from "../payment/requests.js";

const logger = createLogger("revenue.quotes");

export interface BaseBlockProvider {
  getBlockNumber(): Promise<bigint>;
}

export interface QuoteRevenueJobInput {
  jobId: string;
  expiresInHours: number;
  actor: "creator" | "agent";
  blockProvider: BaseBlockProvider;
}

export interface QuoteResult {
  job: RevenueJob;
  paymentRequest: PaymentRequest;
}

/**
 * Quote a draft revenue job: lock scope/price, create linked payment request
 * with a Base block checkpoint, and transition through quoted -> awaiting_payment.
 */
export async function quoteRevenueJob(
  db: DatabaseType,
  input: QuoteRevenueJobInput,
): Promise<QuoteResult> {
  const { jobId, expiresInHours, actor, blockProvider } = input;

  // Validate input
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
    throw new Error(`expires_in_hours must be an integer between 1 and 720, got ${expiresInHours}`);
  }

  // Get the draft job
  const job = getRevenueJob(db, jobId);
  if (!job) {
    throw new Error(`Revenue job not found: ${jobId}`);
  }
  if (job.status !== "draft") {
    throw new Error(`Cannot quote job in ${job.status} state (must be draft)`);
  }

  // Get current block as checkpoint
  const checkpointBlock = await blockProvider.getBlockNumber();

  // Create linked payment request
  const paymentRequest = createPaymentRequest(db, {
    amountUsd: job.priceCents / 100,
    payer: job.customerAddress as Address,
    reference: `revenue-job:${job.id}`,
    description: job.scope,
    expiresInHours,
    paymentNotBeforeBlock: checkpointBlock,
  });

  // Transition: draft -> quoted -> awaiting_payment (in one transaction)
  const txn = db.transaction(() => {
    // draft -> quoted
    transitionRevenueJob(db, {
      jobId,
      to: "quoted",
      eventType: "quote_created",
      actor,
      metadata: {
        paymentRequestId: paymentRequest.id,
        expiresAt: paymentRequest.expiresAt,
        checkpointBlock: checkpointBlock.toString(),
      },
    });

    // quoted -> awaiting_payment
    transitionRevenueJob(db, {
      jobId,
      to: "awaiting_payment",
      eventType: "awaiting_payment",
      actor,
      metadata: {
        paymentRequestId: paymentRequest.id,
      },
    });
  });
  txn();

  // Update job record with payment_request_id
  db.prepare("UPDATE revenue_jobs SET payment_request_id = ? WHERE id = ?").run(
    paymentRequest.id,
    jobId,
  );

  logger.info(`Job ${jobId} quoted: invoice=${paymentRequest.id}, expires=${paymentRequest.expiresAt}, checkpoint=${checkpointBlock}`);

  return { job: getRevenueJob(db, jobId)!, paymentRequest };
}

/**
 * List jobs awaiting payment, useful for heartbeat synchronization.
 */
export function listAwaitingPaymentJobs(db: DatabaseType): Array<{ id: string; paymentRequestId: string }> {
  const rows = db.prepare(
    "SELECT id, payment_request_id FROM revenue_jobs WHERE status = 'awaiting_payment' AND payment_request_id IS NOT NULL ORDER BY created_at ASC",
  ).all() as Array<{ id: string; payment_request_id: string }>;
  return rows.map((r) => ({ id: r.id, paymentRequestId: r.payment_request_id }));
}
