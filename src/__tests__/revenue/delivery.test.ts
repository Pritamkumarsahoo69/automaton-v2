import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../state/database.js";
import { DEFAULT_REVENUE_POLICY } from "../../revenue/types.js";
import { createRevenueJob, transitionRevenueJob, getRevenueJob } from "../../revenue/jobs.js";
import { recordRevenueJobDelivery, flagRevenueJobForRefundApproval } from "../../revenue/delivery.js";
import { createHash } from "crypto";
import type { Address } from "viem";

const CUSTOMER_ADDRESS = "0xabcdef1234567890123456789012345678901234" as Address;
const IDENTITY = {
  name: "test-agent",
  address: "0x9999999999999999999999999999999999999999",
  account: null as any,
  creatorAddress: CUSTOMER_ADDRESS,
  sandboxId: "test-sandbox",
  apiKey: "test-key",
  createdAt: new Date().toISOString(),
  chainType: "evm" as const,
};

function fakeDeps(files: Record<string, Uint8Array> = {}) {
  return {
    readFile: async (path: string) => {
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      return files[path];
    },
    stat: async (path: string) => ({ isFile: () => path in files }),
    verifyGitCommit: async (hash: string) => hash === "valid-commit-hash",
    fetch: async (url: string) => ({ ok: url.includes("healthy"), status: 200 }),
  };
}

/** Create a job and transition it to awaiting_delivery_review. */
function makeAwaitingDeliveryJob(
  db: ReturnType<typeof createDatabase>,
  jobType: string,
  policy: any,
): ReturnType<typeof getRevenueJob> {
  const job = createRevenueJob(db.raw, {
    customerAddress: CUSTOMER_ADDRESS,
    jobType: jobType as any,
    scope: "Test work.",
    priceCents: 5000,
    budgetCents: 1000,
  }, policy, "creator");

  transitionRevenueJob(db.raw, { jobId: job.id, to: "quoted", eventType: "q", actor: "c" });
  transitionRevenueJob(db.raw, { jobId: job.id, to: "awaiting_payment", eventType: "ap", actor: "a" });
  transitionRevenueJob(db.raw, { jobId: job.id, to: "paid", eventType: "paid", actor: "a" });
  transitionRevenueJob(db.raw, { jobId: job.id, to: "executing", eventType: "exec", actor: "a" });
  transitionRevenueJob(db.raw, { jobId: job.id, to: "awaiting_delivery_review", eventType: "done", actor: "a" });

  return getRevenueJob(db.raw, job.id)!;
}

describe("Revenue Job Delivery", () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => { db = createDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("requires a matching SHA-256 file artifact before delivery", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries" };
    const job = makeAwaitingDeliveryJob(db, "writing", policy);
    const content = new TextEncoder().encode("final delivery content");
    const hash = createHash("sha256").update(content).digest("hex");

    const delivered = await recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [{ kind: "file", path: "/tmp/deliveries/final.md", sha256: hash }],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps({ "/tmp/deliveries/final.md": content }));

    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).toBeDefined();
  });

  it("rejects delivery with wrong SHA-256 hash", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries" };
    const job = makeAwaitingDeliveryJob(db, "writing", policy);
    const content = new TextEncoder().encode("delivery content");

    await expect(recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [{ kind: "file", path: "/tmp/deliveries/final.md", sha256: "wronghash" }],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps({ "/tmp/deliveries/final.md": content }))).rejects.toThrow("SHA-256 mismatch");
  });

  it("rejects an unowned hosted-service URL", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries", ownedServiceDomains: ["mine.example"] };
    const job = makeAwaitingDeliveryJob(db, "hosted_service", policy);

    await expect(recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [{ kind: "service", url: "https://attacker.example/health", sandboxId: IDENTITY.sandboxId }],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps())).rejects.toThrow("ownedServiceDomains");
  });

  it("accepts a hosted-service URL on an owned domain", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries", ownedServiceDomains: ["mine.example"] };
    const job = makeAwaitingDeliveryJob(db, "hosted_service", policy);

    const delivered = await recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [{ kind: "service", url: "https://service.mine.example/health", sandboxId: IDENTITY.sandboxId }],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps());

    expect(delivered.status).toBe("delivered");
  });

  it("records a dispute without sending USDC", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries" };
    const job = makeAwaitingDeliveryJob(db, "writing", policy);

    // First deliver it
    const content = new TextEncoder().encode("delivered");
    const hash = createHash("sha256").update(content).digest("hex");
    await recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [{ kind: "file", path: "/tmp/deliveries/out.txt", sha256: hash }],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps({ "/tmp/deliveries/out.txt": content }));

    // Now flag for refund
    const disputed = flagRevenueJobForRefundApproval(db.raw, {
      jobId: job.id,
      reason: "Customer reports missing section.",
      actor: "creator",
    });
    expect(disputed.status).toBe("refunded_pending_creator_approval");

    // Verify no onchain transactions were created
    const count = db.raw.prepare("SELECT COUNT(*) as cnt FROM onchain_transactions").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("rejects delivery for non-awaiting_delivery_review job", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries" };
    const job = createRevenueJob(db.raw, {
      customerAddress: CUSTOMER_ADDRESS,
      jobType: "writing",
      scope: "Test.",
      priceCents: 100,
      budgetCents: 50,
    }, policy, "creator");

    await expect(recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps())).rejects.toThrow("awaiting_delivery_review");
  });

  it("rejects refund flag for non-delivered job", () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries" };
    const job = createRevenueJob(db.raw, {
      customerAddress: CUSTOMER_ADDRESS,
      jobType: "writing",
      scope: "Test.",
      priceCents: 100,
      budgetCents: 50,
    }, policy, "creator");

    expect(() => flagRevenueJobForRefundApproval(db.raw, {
      jobId: job.id,
      reason: "Bad work.",
      actor: "creator",
    })).toThrow("delivered");
  });

  it("requires source_summary for data_analysis jobs", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries" };
    const job = makeAwaitingDeliveryJob(db, "data_analysis", policy);
    const content = new TextEncoder().encode("analysis output");
    const hash = createHash("sha256").update(content).digest("hex");

    // Missing source_summary should fail
    await expect(recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [{ kind: "file", path: "/tmp/deliveries/output.csv", sha256: hash }],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps({ "/tmp/deliveries/output.csv": content }))).rejects.toThrow("source_summary");
  });

  it("requires git_commit for code_change jobs", async () => {
    const policy = { ...DEFAULT_REVENUE_POLICY, enabled: true, deliveryRoot: "/tmp/deliveries" };
    const job = makeAwaitingDeliveryJob(db, "code_change", policy);
    const content = new TextEncoder().encode("changed file");
    const hash = createHash("sha256").update(content).digest("hex");

    // Missing git_commit should fail
    await expect(recordRevenueJobDelivery(db.raw, {
      jobId: job.id,
      evidence: [{ kind: "file", path: "/tmp/deliveries/change.ts", sha256: hash }],
      actor: "agent",
      identity: IDENTITY,
      policy,
    }, fakeDeps({ "/tmp/deliveries/change.ts": content }))).rejects.toThrow("git_commit");
  });
});
