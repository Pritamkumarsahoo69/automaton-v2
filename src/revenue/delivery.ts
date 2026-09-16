/**
 * Revenue Job Delivery
 *
 * Validates delivery evidence (file hashes, Git commits, service URLs)
 * and records delivery or dispute states. Never triggers automatic refunds.
 */

import type { DatabaseType } from "../state/database.js";
import { createHash } from "crypto";
import { createLogger } from "../observability/logger.js";
import { getRevenueJob, transitionRevenueJob } from "./jobs.js";
import type { RevenueJob, RevenuePolicy, DeliveryEvidence } from "./types.js";
import { validateDeliveryEvidence } from "./verification.js";
import { resolvePath } from "../config.js";
import type { AutomatonIdentity } from "../types.js";

const logger = createLogger("revenue.delivery");

export interface DeliveryDependencies {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ isFile(): boolean }>;
  verifyGitCommit(hash: string): Promise<boolean>;
  fetch(url: string): Promise<{ ok: boolean; status: number }>;
}

const DEFAULT_DEPS: DeliveryDependencies = {
  readFile: async (path) => {
    const { promises: fs } = await import("fs");
    return new Uint8Array(await fs.readFile(path));
  },
  stat: async (path) => {
    const { promises: fs } = await import("fs");
    const stats = await fs.stat(path);
    return { isFile: () => stats.isFile() };
  },
  verifyGitCommit: async (hash: string) => {
    const { execSync } = await import("child_process");
    try {
      execSync(`git rev-parse --verify ${hash}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  fetch: async (url) => {
    const resp = await globalThis.fetch(url);
    return { ok: resp.ok, status: resp.status };
  },
};

/**
 * Validate and record delivery evidence for a revenue job.
 * Requires status `awaiting_delivery_review`.
 */
export async function recordRevenueJobDelivery(
  db: DatabaseType,
  input: {
    jobId: string;
    evidence: DeliveryEvidence[];
    actor: "creator" | "agent";
    identity: AutomatonIdentity;
    policy: RevenuePolicy;
  },
  dependencies: DeliveryDependencies = DEFAULT_DEPS,
): Promise<RevenueJob> {
  const { jobId, evidence, actor, identity, policy } = input;

  const job = getRevenueJob(db, jobId);
  if (!job) {
    throw new Error(`Revenue job not found: ${jobId}`);
  }
  if (job.status !== "awaiting_delivery_review") {
    throw new Error(`Job is in ${job.status} state (must be awaiting_delivery_review)`);
  }

  // Validate evidence shape first (structural validation)
  const shapeError = validateDeliveryEvidence(evidence, job.jobType, policy, { sandboxId: identity.sandboxId });
  if (shapeError) {
    throw new Error(`Invalid delivery evidence: ${shapeError}`);
  }

  // Validate each evidence item in detail
  for (const item of evidence) {
    if (item.kind === "file") {
      await validateFileEvidence(item, policy, dependencies);
    } else if (item.kind === "git_commit") {
      const valid = await dependencies.verifyGitCommit(item.hash);
      if (!valid) {
        throw new Error(`Git commit not verified: ${item.hash}`);
      }
    } else if (item.kind === "service") {
      // URL and domain validation already done in validateDeliveryEvidence
      // Health check is optional - just verify the URL is reachable
      const resp = await dependencies.fetch(item.url);
      if (!resp.ok) {
        logger.warn(`Service health check failed for ${item.url}: ${resp.status}`);
      }
    }
    // source_summary is text-only, no validation needed
  }

  // Record delivery
  const txn = db.transaction(() => {
    // Save evidence JSON
    db.prepare(
      "UPDATE revenue_jobs SET delivery_evidence = ?, delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).run(JSON.stringify(evidence), jobId);

    transitionRevenueJob(db, {
      jobId,
      to: "delivered",
      eventType: "delivery_verified",
      actor,
      metadata: { evidenceCount: evidence.length },
    });
  });
  txn();

  logger.info(`Job ${jobId} delivered with ${evidence.length} evidence item(s)`);
  return getRevenueJob(db, jobId)!;
}

/**
 * Flag a delivered job for refund approval.
 * Does NOT trigger any USDC transfer — creator must authorize separately.
 */
export function flagRevenueJobForRefundApproval(
  db: DatabaseType,
  input: { jobId: string; reason: string; actor: "creator" | "agent" },
): RevenueJob {
  const { jobId, reason, actor } = input;

  const job = getRevenueJob(db, jobId);
  if (!job) {
    throw new Error(`Revenue job not found: ${jobId}`);
  }
  if (job.status !== "delivered") {
    throw new Error(`Job is in ${job.status} state (must be delivered to request refund)`);
  }

  // Sanitize reason
  const sanitizedReason = reason.slice(0, 2000);

  const txn = db.transaction(() => {
    transitionRevenueJob(db, {
      jobId,
      to: "refunded_pending_creator_approval",
      eventType: "refund_requested",
      actor,
      metadata: { reason: sanitizedReason },
    });
  });
  txn();

  logger.info(`Job ${jobId} flagged for refund approval`);
  return getRevenueJob(db, jobId)!;
}

async function validateFileEvidence(
  evidence: Extract<DeliveryEvidence, { kind: "file" }>,
  policy: RevenuePolicy,
  deps: DeliveryDependencies,
): Promise<void> {
  const resolvedPath = resolvePath(evidence.path);
  const deliveryRoot = resolvePath(policy.deliveryRoot);

  // Path confinement: must be within delivery root
  if (!resolvedPath.startsWith(deliveryRoot)) {
    throw new Error(`Evidence path "${evidence.path}" is outside delivery root "${policy.deliveryRoot}"`);
  }

  const stat = await deps.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Evidence path is not a file: ${evidence.path}`);
  }

  const bytes = await deps.readFile(resolvedPath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");

  if (actualHash !== evidence.sha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${evidence.path}: expected ${evidence.sha256}, got ${actualHash}`,
    );
  }
}
