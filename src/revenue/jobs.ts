/**
 * Revenue Job Repository
 *
 * Strict state machine for revenue jobs with append-only event logging.
 */

import type { DatabaseType } from "../state/database.js";
import { ulid } from "ulid";
import type { Address } from "viem";
import { createLogger } from "../observability/logger.js";
import type {
  RevenueJob,
  RevenueJobEvent,
  RevenueJobStatus,
  RevenueJobType,
  RevenuePolicy,
  CreateRevenueJobInput,
} from "./types.js";
import { validateRevenueJobInput } from "./verification.js";

const logger = createLogger("revenue.jobs");

/**
 * Strict state transition map.
 * Any transition not listed here is rejected.
 */
const ALLOWED_TRANSITIONS: Record<RevenueJobStatus, readonly RevenueJobStatus[]> = {
  draft: ["quoted", "cancelled"],
  quoted: ["awaiting_payment", "cancelled"],
  awaiting_payment: ["paid", "expired", "cancelled"],
  paid: ["executing", "cancelled"],
  executing: ["awaiting_delivery_review", "failed"],
  awaiting_delivery_review: ["delivered", "failed"],
  delivered: ["refunded_pending_creator_approval"],
  cancelled: [],
  expired: [],
  failed: [],
  refunded_pending_creator_approval: [],
};

export interface TransitionInput {
  jobId: string;
  to: RevenueJobStatus;
  eventType: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create a new revenue job in draft status.
 */
export function createRevenueJob(
  db: DatabaseType,
  input: CreateRevenueJobInput,
  policy: RevenuePolicy,
  actor: "creator" | "agent" | "external",
): RevenueJob {
  const validated = validateRevenueJobInput(input, policy);
  const id = ulid();
  const now = new Date().toISOString();

  const insertJob = db.transaction(() => {
    db.prepare(`
      INSERT INTO revenue_jobs (
        id, customer_address, job_type, scope, price_cents, budget_cents,
        status, delivery_requirements, delivery_evidence, failure_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, '[]', NULL, datetime('now'), datetime('now'))
    `).run(
      id,
      validated.customerAddress,
      validated.jobType,
      validated.scope,
      validated.priceCents,
      validated.budgetCents,
      JSON.stringify(validated.deliveryRequirements),
    );

    db.prepare(`
      INSERT INTO revenue_job_events (id, job_id, from_status, to_status, event_type, metadata, actor, created_at)
      VALUES (?, ?, NULL, 'draft', 'job_created', ?, ?, ?)
    `).run(
      ulid(),
      id,
      JSON.stringify({ priceCents: validated.priceCents, budgetCents: validated.budgetCents }),
      actor,
      now,
    );
  });
  insertJob();

  logger.info(`Revenue job created: ${id}, type=${validated.jobType}, price=${validated.priceCents}¢`);

  return {
    id,
    customerAddress: validated.customerAddress,
    jobType: validated.jobType,
    scope: validated.scope,
    priceCents: validated.priceCents,
    budgetCents: validated.budgetCents,
    status: "draft",
    paymentRequestId: undefined,
    goalId: undefined,
    deliveryRequirements: validated.deliveryRequirements,
    deliveryEvidence: [],
    failureReason: undefined,
    createdAt: now,
    quotedAt: undefined,
    paidAt: undefined,
    startedAt: undefined,
    deliveredAt: undefined,
    updatedAt: now,
  };
}

/**
 * Transition a revenue job to a new status.
 * Enforces the strict state machine and appends an audit event.
 */
export function transitionRevenueJob(
  db: DatabaseType,
  input: TransitionInput,
): RevenueJob {
  const { jobId, to, eventType, actor, metadata } = input;

  // Get current job
  const row = db.prepare("SELECT * FROM revenue_jobs WHERE id = ?").get(jobId) as any;
  if (!row) {
    throw new Error(`Revenue job not found: ${jobId}`);
  }

  const fromStatus = row.status as RevenueJobStatus;
  const allowed = ALLOWED_TRANSITIONS[fromStatus];

  if (!allowed || !allowed.includes(to)) {
    throw new Error(
      `Invalid revenue job transition: ${fromStatus} -> ${to} (allowed: [${allowed?.join(", ") || "none"}])`,
    );
  }

  const now = new Date().toISOString();

  const updateJob = db.transaction(() => {
    // Update status and relevant timestamp
    const setClauses: string[] = ["status = ?", "updated_at = datetime('now')"];
    const params: unknown[] = [to];

    // Set timestamp column based on target status
    if (to === "quoted") {
      setClauses.push("quoted_at = ?");
      params.push(now);
    } else if (to === "paid") {
      setClauses.push("paid_at = ?");
      params.push(now);
    } else if (to === "executing") {
      setClauses.push("started_at = ?");
      params.push(now);
    } else if (to === "delivered") {
      setClauses.push("delivered_at = ?");
      params.push(now);
    } else if (to === "failed" || to === "cancelled" || to === "expired") {
      setClauses.push("failure_reason = COALESCE(failure_reason, ?)");
      params.push(metadata?.reason as string | null ?? null);
    }

    db.prepare(`UPDATE revenue_jobs SET ${setClauses.join(", ")} WHERE id = ?`).run(...params, jobId);

    // Append audit event
    db.prepare(`
      INSERT INTO revenue_job_events (id, job_id, from_status, to_status, event_type, metadata, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ulid(),
      jobId,
      fromStatus,
      to,
      eventType,
      JSON.stringify(metadata ?? {}),
      actor,
      now,
    );
  });
  updateJob();

  logger.info(`Revenue job ${jobId}: ${fromStatus} -> ${to} (${eventType})`);

  // Return updated job
  return getRevenueJob(db, jobId)!;
}

/**
 * Get a single revenue job by ID.
 */
export function getRevenueJob(db: DatabaseType, jobId: string): RevenueJob | undefined {
  const row = db.prepare("SELECT * FROM revenue_jobs WHERE id = ?").get(jobId) as any;
  if (!row) return undefined;
  return deserializeRevenueJob(row);
}

/**
 * List revenue jobs with optional filters.
 */
export function listRevenueJobs(
  db: DatabaseType,
  filter?: { status?: RevenueJobStatus; customerAddress?: string },
): RevenueJob[] {
  let query = "SELECT * FROM revenue_jobs";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.customerAddress) {
    conditions.push("customer_address = ?");
    params.push(filter.customerAddress.toLowerCase());
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY created_at DESC";

  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(deserializeRevenueJob);
}

/**
 * List audit events for a revenue job.
 */
export function listRevenueJobEvents(db: DatabaseType, jobId: string): RevenueJobEvent[] {
  const rows = db.prepare(
    "SELECT * FROM revenue_job_events WHERE job_id = ? ORDER BY created_at ASC",
  ).all(jobId) as any[];
  return rows.map(deserializeRevenueJobEvent);
}

function deserializeRevenueJob(row: any): RevenueJob {
  return {
    id: row.id,
    customerAddress: row.customer_address,
    jobType: row.job_type as RevenueJobType,
    scope: row.scope,
    priceCents: row.price_cents,
    budgetCents: row.budget_cents,
    status: row.status as RevenueJobStatus,
    paymentRequestId: row.payment_request_id,
    goalId: row.goal_id,
    deliveryRequirements: JSON.parse(row.delivery_requirements || "{}"),
    deliveryEvidence: JSON.parse(row.delivery_evidence || "[]"),
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    quotedAt: row.quoted_at,
    paidAt: row.paid_at,
    startedAt: row.started_at,
    deliveredAt: row.delivered_at,
    updatedAt: row.updated_at,
  };
}

function deserializeRevenueJobEvent(row: any): RevenueJobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    fromStatus: row.from_status as RevenueJobStatus | undefined,
    toStatus: row.to_status as RevenueJobStatus,
    eventType: row.event_type,
    metadata: JSON.parse(row.metadata || "{}"),
    actor: row.actor,
    createdAt: row.created_at,
  };
}
