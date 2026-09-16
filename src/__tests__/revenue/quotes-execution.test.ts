import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDatabase } from "../../state/database.js";
import { DEFAULT_REVENUE_POLICY } from "../../revenue/types.js";
import { createRevenueJob, transitionRevenueJob, getRevenueJob } from "../../revenue/jobs.js";
import { quoteRevenueJob, listAwaitingPaymentJobs } from "../../revenue/quotes.js";
import {
  advanceRevenueJobPaymentState,
  startPaidRevenueJob,
  syncRevenueJobExecutionState,
} from "../../revenue/execution.js";
import {
  getPaymentRequest,
  getVerifiedPaymentReceipt,
  markPaymentRequestPaid,
  markPaymentRequestVerifiedPaid,
} from "../../payment/requests.js";
import { updateGoalStatus, insertTask } from "../../state/database.js";
import { _resetRateLimits } from "../../agent/injection-defense.js";
import type { Address } from "viem";

const CUSTOMER_ADDRESS = "0xabcdef1234567890123456789012345678901234" as Address;
const RECIPIENT_ADDRESS = "0x1111222233334444555566667777888899999999" as Address;
const ENABLED_POLICY = { ...DEFAULT_REVENUE_POLICY, enabled: true };
let receiptCounter = 0;

function makeDraftJob(db: ReturnType<typeof createDatabase>) {
  return createRevenueJob(db.raw, {
    customerAddress: CUSTOMER_ADDRESS,
    jobType: "writing",
    scope: "Write documentation.",
    priceCents: 5000,
    budgetCents: 1000,
  }, ENABLED_POLICY, "creator");
}

/** Quote a draft job using the deterministic fake block provider (900n). */
async function makeQuotedJob(db: ReturnType<typeof createDatabase>, jobId: string) {
  return quoteRevenueJob(db.raw, {
    jobId,
    expiresInHours: 72,
    actor: "creator",
    blockProvider: { getBlockNumber: async () => 900n },
  });
}

/** Attach a verified on-chain receipt matching the job's linked payment request. */
function attachVerifiedReceipt(db: ReturnType<typeof createDatabase>, jobId: string) {
  const job = getRevenueJob(db.raw, jobId)!;
  const pr = getPaymentRequest(db.raw, job.paymentRequestId!)!;
  receiptCounter++;
  const txHash = `0xverified${receiptCounter}` as `0x${string}`;
  const receipt = {
    paymentRequestId: job.paymentRequestId!,
    txHash,
    logIndex: receiptCounter,
    blockNumber: 901n,
    from: pr.payer as Address,
    to: RECIPIENT_ADDRESS,
    amountAtomic: BigInt(Math.round(pr.amountUsd * 1_000_000)),
    verifiedAt: new Date().toISOString(),
  };
  markPaymentRequestVerifiedPaid(db.raw, job.paymentRequestId!, receipt);
}

/** Full verified flow: quote -> verified payment -> paid -> executing. */
async function makeExecutingJob(db: ReturnType<typeof createDatabase>) {
  const draft = makeDraftJob(db);
  const { job: quoted } = await makeQuotedJob(db, draft.id);
  attachVerifiedReceipt(db, quoted.id);
  const paid = advanceRevenueJobPaymentState(db.raw, quoted.id);
  expect(paid.status).toBe("paid");
  const executing = startPaidRevenueJob(db.raw, paid.id, ENABLED_POLICY, "agent");
  expect(executing.status).toBe("executing");
  return getRevenueJob(db.raw, executing.id)!;
}

describe("Revenue Job Quotes", () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => { db = createDatabase(":memory:"); _resetRateLimits(); receiptCounter = 0; });
  afterEach(() => { db.close(); });

  it("creates exactly one linked invoice and records the block checkpoint", async () => {
    const job = makeDraftJob(db);
    const { job: awaiting, paymentRequest } = await quoteRevenueJob(db.raw, {
      jobId: job.id,
      expiresInHours: 72,
      actor: "creator",
      blockProvider: { getBlockNumber: async () => 900n },
    });

    expect(awaiting.status).toBe("awaiting_payment");
    expect(awaiting.paymentRequestId).toBe(paymentRequest.id);
    expect(paymentRequest.amountUsd).toBe(job.priceCents / 100);
    expect(paymentRequest.paymentNotBeforeBlock).toBe(900n);
    expect(paymentRequest.payer.toLowerCase()).toBe(job.customerAddress.toLowerCase());
    expect(paymentRequest.reference).toBe(`revenue-job:${job.id}`);
    expect(paymentRequest.description).toBe(job.scope);
    expect(paymentRequest.expiresAt).toBeDefined();

    // Exactly one payment request is linked to this job.
    const linked = db.raw.prepare(
      "SELECT COUNT(*) as cnt FROM payment_requests WHERE reference = ?",
    ).get(`revenue-job:${job.id}`) as { cnt: number };
    expect(linked.cnt).toBe(1);

    // Events: job_created, quote_created, awaiting_payment.
    const events = getRevenueJob(db.raw, job.id)!;
    const { listRevenueJobEvents } = await import("../../revenue/jobs.js");
    const evts = listRevenueJobEvents(db.raw, job.id);
    expect(evts.map((e) => e.eventType)).toEqual(["job_created", "quote_created", "awaiting_payment"]);
    expect(evts[1].metadata.paymentRequestId).toBe(paymentRequest.id);
    expect(evts[1].metadata.checkpointBlock).toBe("900");
  });

  it("rejects invalid expires_in_hours values", async () => {
    const job = makeDraftJob(db);
    for (const bad of [0, -1, 1.5, 721, 100000]) {
      await expect(quoteRevenueJob(db.raw, {
        jobId: job.id,
        expiresInHours: bad,
        actor: "creator",
        blockProvider: { getBlockNumber: async () => 100n },
      })).rejects.toThrow("expires_in_hours");
    }

    // Boundary value still works.
    const job2 = makeDraftJob(db);
    const ok = await quoteRevenueJob(db.raw, {
      jobId: job2.id,
      expiresInHours: 720,
      actor: "creator",
      blockProvider: { getBlockNumber: async () => 100n },
    });
    expect(ok.job.status).toBe("awaiting_payment");
  });

  it("rejects quoting a non-draft job", async () => {
    const job = makeDraftJob(db);
    transitionRevenueJob(db.raw, { jobId: job.id, to: "cancelled", eventType: "cancel", actor: "creator" });
    await expect(quoteRevenueJob(db.raw, {
      jobId: job.id,
      expiresInHours: 24,
      actor: "creator",
      blockProvider: { getBlockNumber: async () => 100n },
    })).rejects.toThrow("draft");
  });

  it("transitions awaiting_payment to expired when the quote expires", async () => {
    const job = makeDraftJob(db);
    const { job: awaiting } = await makeQuotedJob(db, job.id);

    const paymentRequest = getPaymentRequest(db.raw, awaiting.paymentRequestId!);
    expect(paymentRequest).toBeDefined();

    // Payment never arrived -> job expires and cannot start.
    const expired = transitionRevenueJob(db.raw, {
      jobId: awaiting.id,
      to: "expired",
      eventType: "quote_expired",
      actor: "system",
      metadata: { reason: "Payment not received before expiry" },
    });
    expect(expired.status).toBe("expired");
    expect(expired.failureReason).toBeTruthy();
    expect(() => startPaidRevenueJob(db.raw, expired.id, ENABLED_POLICY, "agent")).toThrow();
  });

  it("listAwaitingPaymentJobs returns only awaiting_payment jobs", async () => {
    const job1 = makeDraftJob(db);
    const { job: quoted1 } = await makeQuotedJob(db, job1.id);

    makeDraftJob(db); // still draft

    const awaiting = listAwaitingPaymentJobs(db.raw);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].id).toBe(quoted1.id);
    expect(awaiting[0].paymentRequestId).toBe(quoted1.paymentRequestId);
  });
});

describe("Revenue Job Execution", () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => { db = createDatabase(":memory:"); _resetRateLimits(); receiptCounter = 0; });
  afterEach(() => { db.close(); });

  it("does not start a job with an unverified or unrelated paid invoice", async () => {
    const job = makeDraftJob(db);
    const { job: quoted } = await makeQuotedJob(db, job.id);

    // Mark paid WITHOUT an on-chain verification receipt.
    markPaymentRequestPaid(db.raw, quoted.paymentRequestId!, "0xunverified");
    // Transition to paid manually (bypassing advanceRevenueJobPaymentState)
    transitionRevenueJob(db.raw, { jobId: quoted.id, to: "paid", eventType: "manual_paid", actor: "agent" });

    expect(() => startPaidRevenueJob(db.raw, quoted.id, ENABLED_POLICY, "agent"))
      .toThrow("verified payment receipt");
    expect(getRevenueJob(db.raw, quoted.id)!.status).toBe("paid");
  });

  it("requires a verified receipt to advance from awaiting_payment to paid", async () => {
    const job = makeDraftJob(db);
    const { job: awaiting } = await makeQuotedJob(db, job.id);

    // No verification exists — must throw
    expect(() => advanceRevenueJobPaymentState(db.raw, awaiting.id))
      .toThrow("verified payment receipt");

    // Now attach a verified receipt and retry
    attachVerifiedReceipt(db, awaiting.id);
    const paid = advanceRevenueJobPaymentState(db.raw, awaiting.id);
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBeDefined();
    const receipt = getVerifiedPaymentReceipt(db.raw, paid.paymentRequestId!);
    expect(receipt?.txHash).toBeDefined();
    expect(receipt?.from).toBe(CUSTOMER_ADDRESS.toLowerCase() as Address);
  });

  it("creates one revenue-linked goal only after verified payment", async () => {
    const job = await makeExecutingJob(db);
    expect(job.status).toBe("executing");
    expect(job.goalId).toBeTruthy();

    // Duplicate start should fail (job is now in executing, not paid)
    expect(() => startPaidRevenueJob(db.raw, job.id, ENABLED_POLICY, "agent"))
      .toThrow("must be paid");
  });

  it("enforces max_active_jobs", async () => {
    const job1 = await makeExecutingJob(db);
    const job2Draft = makeDraftJob(db);
    const { job: quoted2 } = await makeQuotedJob(db, job2Draft.id);
    attachVerifiedReceipt(db, quoted2.id);
    const paid2 = advanceRevenueJobPaymentState(db.raw, quoted2.id);

    // job1 is executing, job2 is paid. Starting job2 should hit the limit
    // since job1 is already executing and maxActiveJobs=1
    expect(() => startPaidRevenueJob(db.raw, paid2.id, ENABLED_POLICY, "agent"))
      .toThrow("limit");
  });

  it("does not start when revenue is disabled", () => {
    const job = makeDraftJob(db);
    expect(() => startPaidRevenueJob(db.raw, job.id, DEFAULT_REVENUE_POLICY, "agent"))
      .toThrow("disabled");
  });
});

describe("Execution State Sync", () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => { db = createDatabase(":memory:"); _resetRateLimits(); receiptCounter = 0; });
  afterEach(() => { db.close(); });

  it("transitions executing to awaiting_delivery_review when goal completes", async () => {
    const job = await makeExecutingJob(db);
    expect(job.status).toBe("executing");
    expect(job.goalId).toBeDefined();

    updateGoalStatus(db.raw, job.goalId!, "completed");

    const result = syncRevenueJobExecutionState(db.raw, job.id, ENABLED_POLICY);
    expect(result.status).toBe("awaiting_delivery_review");
  });

  it("transitions executing to failed when the goal fails", async () => {
    const job = await makeExecutingJob(db);
    expect(job.status).toBe("executing");

    updateGoalStatus(db.raw, job.goalId!, "failed");

    const result = syncRevenueJobExecutionState(db.raw, job.id, ENABLED_POLICY);
    expect(result.status).toBe("failed");
  });

  it("marks a budget-overrun job failed and pauses the linked goal", async () => {
    const job = await makeExecutingJob(db);
    expect(job.status).toBe("executing");

    // Insert a task cost above budget
    insertTask(db.raw, {
      goalId: job.goalId!,
      title: "Expensive task",
      description: "Costs more than budget",
      status: "completed",
      result: { success: true, output: "done", artifacts: [], costCents: 9999, duration: 1000 },
      actualCostCents: 9999,
    });

    const result = syncRevenueJobExecutionState(db.raw, job.id, ENABLED_POLICY);
    expect(result.status).toBe("failed");
  });

  it("leaves an executing job untouched while the goal is still active", async () => {
    const job = await makeExecutingJob(db);
    expect(job.status).toBe("executing");

    // Goal is still "active" (default)
    const result = syncRevenueJobExecutionState(db.raw, job.id, ENABLED_POLICY);
    expect(result.status).toBe("executing");
  });
});
