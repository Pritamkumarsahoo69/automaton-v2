import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../state/database.js";
import { DEFAULT_REVENUE_POLICY } from "../../revenue/types.js";

describe("Revenue schema and configuration", () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => { db = createDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("applies migration 13 with revenue tables and payment receipt provenance", () => {
    const tables = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('revenue_jobs', 'revenue_job_events', 'payment_verifications') ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "payment_verifications", "revenue_job_events", "revenue_jobs",
    ]);

    const columns = db.raw.prepare("PRAGMA table_info(payment_requests)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("payment_not_before_block");
  });

  it("keeps revenue processing disabled by default", () => {
    expect(DEFAULT_REVENUE_POLICY.enabled).toBe(false);
    expect(DEFAULT_REVENUE_POLICY.ownedServiceDomains).toEqual([]);
  });
});
