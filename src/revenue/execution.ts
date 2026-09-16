/**
 * Revenue Job Execution
 *
 * Gates job execution on verified Base USDC payment, creates orchestration
 * goals, and synchronizes terminal goal states back to job lifecycle.
 */

import type { DatabaseType } from "../state/database.js";
import { createLogger } from "../observability/logger.js";
import { getRevenueJob, transitionRevenueJob } from "./jobs.js";
import type { RevenueJob, RevenuePolicy } from "./types.js";
import { getVerifiedPaymentReceipt } from "../payment/requests.js";
import { insertGoal, getGoalById, updateGoalStatus } from "../state/database.js";

const logger = createLogger("revenue.execution");

/**
 * Advance a job from awaiting_payment to paid by verifying the linked
 * Base USDC payment receipt. Throws if no verified receipt exists.
 */
export function advanceRevenueJobPaymentState(db: DatabaseType, jobId: string): RevenueJob {
  const job = getRevenueJob(db, jobId);
  if (!job) {
    throw new Error(`Revenue job not found: ${jobId}`);
  }
  if (job.status !== "awaiting_payment") {
    throw new Error(`Job is in ${job.status} state (must be awaiting_payment)`);
  }
  if (!job.paymentRequestId) {
    throw new Error(`Job ${jobId} has no linked payment request`);
  }

  const receipt = getVerifiedPaymentReceipt(db, job.paymentRequestId);
  if (!receipt) {
    throw new Error(`No verified payment receipt found for payment request ${job.paymentRequestId}`);
  }

  // Verify receipt matches the job
  if (receipt.from.toLowerCase() !== job.customerAddress.toLowerCase()) {
    throw new Error(`Payment receipt sender ${receipt.from} does not match job customer ${job.customerAddress}`);
  }
  const expectedAtomic = BigInt(job.priceCents) * 10_000n;
  if (receipt.amountAtomic !== expectedAtomic) {
    throw new Error(`Payment amount mismatch: receipt=${receipt.amountAtomic}, expected=${expectedAtomic}`);
  }

  transitionRevenueJob(db, {
    jobId,
    to: "paid",
    eventType: "payment_verified",
    actor: "agent",
    metadata: {
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber.toString(),
      from: receipt.from,
      amountAtomic: receipt.amountAtomic.toString(),
    },
  });

  logger.info(`Job ${jobId} paid: tx=${receipt.txHash}, block=${receipt.blockNumber}`);
  return getRevenueJob(db, jobId)!;
}

/**
 * Start a paid job: create an orchestration goal and transition to executing.
 * Enforces max active jobs limit.
 */
export function startPaidRevenueJob(
  db: DatabaseType,
  jobId: string,
  policy: RevenuePolicy,
  actor: "creator" | "agent",
): RevenueJob {
  if (!policy.enabled) {
    throw new Error("Revenue job engine is disabled");
  }

  const job = getRevenueJob(db, jobId);
  if (!job) {
    throw new Error(`Revenue job not found: ${jobId}`);
  }
  if (job.status !== "paid") {
    throw new Error(`Job is in ${job.status} state (must be paid)`);
  }
  if (job.goalId) {
    throw new Error(`Job ${jobId} already has a goal attached (status: ${job.status})`);
  }
  // Require verified payment receipt before allowing execution
  if (!job.paymentRequestId) {
    throw new Error(`Job ${jobId} has no linked payment request`);
  }
  const receipt = getVerifiedPaymentReceipt(db, job.paymentRequestId);
  if (!receipt) {
    throw new Error(`No verified payment receipt found for payment request ${job.paymentRequestId}`);
  }

  // Check active job limit (exclude current job from count)
  const activeCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM revenue_jobs WHERE status IN ('paid', 'executing') AND id != ?",
  ).get(jobId) as { cnt: number };
  if (activeCount.cnt + 1 > policy.maxActiveJobs) {
    throw new Error(`Active job limit reached (${policy.maxActiveJobs})`);
  }

  // Create orchestration goal
  const goalId = insertGoal(db, {
    title: `Paid ${job.jobType}: ${job.id}`,
    description: `Revenue job ${job.id}\nScope: ${job.scope}\nBudget: ${job.budgetCents} cents\nDo not alter constitution, wallet, policy, payment destination, or protected files.\nCustomer: ${job.customerAddress}`,
    strategy: `revenue_job:${job.id}`,
    expectedRevenueCents: job.priceCents,
    actualRevenueCents: 0,
  });

  // Update job with goal_id and transition to executing
  const txn = db.transaction(() => {
    db.prepare("UPDATE revenue_jobs SET goal_id = ? WHERE id = ?").run(goalId, jobId);
    transitionRevenueJob(db, {
      jobId,
      to: "executing",
      eventType: "execution_started",
      actor,
      metadata: { goalId },
    });
  });
  txn();

  logger.info(`Job ${jobId} started: goal=${goalId}`);
  return getRevenueJob(db, jobId)!;
}

/**
 * Synchronize execution state based on the linked orchestration goal.
 * - Completed goal -> awaiting_delivery_review
 * - Failed goal -> failed
 * - Budget exceeded -> failed (with goal paused)
 */
export function syncRevenueJobExecutionState(
  db: DatabaseType,
  jobId: string,
  policy: RevenuePolicy,
): RevenueJob {
  const job = getRevenueJob(db, jobId);
  if (!job) {
    throw new Error(`Revenue job not found: ${jobId}`);
  }
  if (job.status !== "executing") {
    throw new Error(`Job is in ${job.status} state (must be executing)`);
  }
  if (!job.goalId) {
    throw new Error(`Job ${jobId} has no linked goal`);
  }

  const goal = getGoalById(db, job.goalId);
  if (!goal) {
    throw new Error(`Goal ${job.goalId} not found for job ${jobId}`);
  }

  // Check budget exhaustion
  const costRow = db.prepare(
    `SELECT COALESCE(SUM(actual_cost_cents), 0) as total FROM task_graph WHERE goal_id = ?`,
  ).get(job.goalId) as { total: number };

  if (costRow.total > job.budgetCents) {
    updateGoalStatus(db, job.goalId, "paused");
    transitionRevenueJob(db, {
      jobId,
      to: "failed",
      eventType: "budget_exceeded",
      actor: "system",
      metadata: { goalId: job.goalId, spentCents: costRow.total, budgetCents: job.budgetCents },
    });
    logger.warn(`Job ${jobId} failed: budget exceeded (${costRow.total}¢ > ${job.budgetCents}¢)`);
    return getRevenueJob(db, jobId)!;
  }

  // Check goal completion
  if (goal.status === "completed") {
    transitionRevenueJob(db, {
      jobId,
      to: "awaiting_delivery_review",
      eventType: "execution_completed",
      actor: "system",
      metadata: { goalId: job.goalId },
    });
    logger.info(`Job ${jobId} execution complete, awaiting delivery review`);
    return getRevenueJob(db, jobId)!;
  }

  // Check goal failure
  if (goal.status === "failed") {
    transitionRevenueJob(db, {
      jobId,
      to: "failed",
      eventType: "goal_failed",
      actor: "system",
      metadata: { goalId: job.goalId, reason: goal.description?.slice(0, 500) },
    });
    logger.warn(`Job ${jobId} failed: linked goal ${job.goalId} failed`);
    return getRevenueJob(db, jobId)!;
  }

  // Goal is still active/paused - no state change
  return job;
}
