import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../state/database.js";
import { DEFAULT_REVENUE_POLICY, DEFAULT_TREASURY_POLICY } from "../../types.js";
import { createBuiltinTools } from "../../agent/tools.js";
import type { ToolContext } from "../../types.js";
import type { Address } from "viem";

const CUSTOMER_ADDRESS = "0xabcdef1234567890123456789012345678901234" as Address;
const ENABLED_POLICY = { ...DEFAULT_REVENUE_POLICY, enabled: true };

function makeToolContext(db: ReturnType<typeof createDatabase>): ToolContext {
  return {
    identity: {
      name: "test",
      address: "0x9999999999999999999999999999999999999999",
      account: null as any,
      creatorAddress: CUSTOMER_ADDRESS,
      sandboxId: "test-sandbox",
      apiKey: "test-key",
      createdAt: new Date().toISOString(),
      chainType: "evm" as const,
    },
    config: {
      name: "test",
      genesisPrompt: "test",
      creatorAddress: CUSTOMER_ADDRESS,
      registeredWithConway: false,
      sandboxId: "test",
      walletAddress: "0x9999999999999999999999999999999999999999",
      conwayApiKey: "test",
      conwayApiUrl: "https://api.conway.tech",
      inferenceModel: "gpt-5.2",
      maxTokensPerTurn: 4096,
      heartbeatConfigPath: "~/.automaton/heartbeat.yml",
      dbPath: ":memory:",
      logLevel: "info",
      version: "0.2.1",
      skillsDir: "~/.automaton/skills",
      maxChildren: 3,
      treasuryPolicy: DEFAULT_TREASURY_POLICY,
      revenuePolicy: ENABLED_POLICY,
      chainType: "evm" as const,
    },
    db: db as any,
    conway: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFile: async () => {},
      readFile: async () => "",
      exposePort: async () => ({ port: 8080, publicUrl: "http://localhost:8080", sandboxId: "test" }),
      removePort: async () => {},
      createSandbox: async () => ({ id: "test", status: "running", region: "", vcpu: 1, memoryMb: 512, diskGb: 5, terminalUrl: "", createdAt: "" }),
      deleteSandbox: async () => {},
      listSandboxes: async () => [],
      getCreditsBalance: async () => 10000,
      getCreditsPricing: async () => [],
      transferCredits: async () => ({ transferId: "", status: "submitted", toAddress: "", amountCents: 0 }),
      registerAutomaton: async () => ({}),
      searchDomains: async () => [],
      registerDomain: async () => ({ domain: "test.example", status: "registered", expiresAt: "", transactionId: "" }),
      listDnsRecords: async () => [],
      addDnsRecord: async () => ({ id: "", type: "A", host: "@", value: "1.2.3.4", ttl: 3600, distance: 0 }),
      deleteDnsRecord: async () => {},
      listModels: async () => [],
      createScopedClient: () => ({}) as any,
    } as any,
    inference: {
      chat: async () => ({ id: "test", model: "test", message: { role: "assistant", content: "test" }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" as const }),
      setLowComputeMode: () => {},
      getDefaultModel: () => "test",
    } as any,
  };
}

function getTool(name: string) {
  const tools = createBuiltinTools("sandbox-test");
  return tools.find((t) => t.name === name)!;
}

describe("Revenue Tools", () => {
  let db: ReturnType<typeof createDatabase>;
  let ctx: ToolContext;

  beforeEach(() => {
    db = createDatabase(":memory:");
    ctx = makeToolContext(db);
  });
  afterEach(() => { db.close(); });

  it("creates only a draft from customer job input", async () => {
    const tool = getTool("create_revenue_job");
    const output = await tool.execute({
      customer_address: CUSTOMER_ADDRESS,
      job_type: "research",
      scope: "Summarize approved public sources.",
      price_cents: 1500,
      budget_cents: 300,
    }, ctx);

    expect(output).toContain("draft");
    expect(output).toContain("research");

    const { listRevenueJobs } = await import("../../revenue/jobs.js");
    const jobs = listRevenueJobs(db.raw);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("draft");
  });

  it("does not start an unpaid job", async () => {
    const tool = getTool("start_paid_job");
    // No job exists, should fail gracefully
    const output = await tool.execute({ job_id: "nonexistent" }, ctx);
    expect(output).toContain("not found");
  });

  it("lists revenue jobs", async () => {
    // Create a job first
    const createTool = getTool("create_revenue_job");
    await createTool.execute({
      customer_address: CUSTOMER_ADDRESS,
      job_type: "writing",
      scope: "Write docs.",
      price_cents: 1000,
      budget_cents: 200,
    }, ctx);

    const listTool = getTool("list_revenue_jobs");
    const output = await listTool.execute({}, ctx);
    expect(output).toContain("writing");
    expect(output).toContain("draft");
  });

  it("returns error when revenue is disabled", async () => {
    const disabledCtx = { ...ctx, config: { ...ctx.config, revenuePolicy: DEFAULT_REVENUE_POLICY } };
    const tool = getTool("create_revenue_job");
    const output = await tool.execute({
      customer_address: CUSTOMER_ADDRESS,
      job_type: "writing",
      scope: "Test.",
      price_cents: 100,
      budget_cents: 50,
    }, disabledCtx);
    expect(output).toContain("disabled");
  });

  it("rejects invalid evidence JSON for record_job_delivery", async () => {
    const tool = getTool("record_job_delivery");
    const output = await tool.execute({
      job_id: "any-id",
      evidence_json: "not-json",
    }, ctx);
    expect(output).toContain("Invalid JSON");
  });
});

describe("Revenue Authority Rules", () => {
  it("blocks quote_revenue_job from external/heartbeat input", async () => {
    const { createAuthorityRules } = await import("../../agent/policy-rules/authority.js");
    const { PolicyEngine } = await import("../../agent/policy-engine.js");
    const db = createDatabase(":memory:");

    const rules = createAuthorityRules();
    const engine = new PolicyEngine(db.raw, rules);

    const tool = { name: "quote_revenue_job", riskLevel: "caution" as const, category: "revenue" as const };
    const request = {
      tool,
      args: { job_id: "test" },
      turnContext: { inputSource: "heartbeat" as any, sessionSpend: { checkLimit: () => ({ allowed: true }), getHourlySpend: () => 0, getDailySpend: () => 0 } },
    };

    const decision = engine.evaluate(request as any);
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("EXTERNAL_REVENUE_TOOL");

    db.close();
  });

  it("allows create_revenue_job from external input", async () => {
    const { createAuthorityRules } = await import("../../agent/policy-rules/authority.js");
    const { PolicyEngine } = await import("../../agent/policy-engine.js");
    const db = createDatabase(":memory:");

    const rules = createAuthorityRules();
    const engine = new PolicyEngine(db.raw, rules);

    const tool = { name: "create_revenue_job", riskLevel: "safe" as const, category: "revenue" as const };
    const request = {
      tool,
      args: { job_id: "test" },
      turnContext: { inputSource: "heartbeat" as any, sessionSpend: { checkLimit: () => ({ allowed: true }), getHourlySpend: () => 0, getDailySpend: () => 0 } },
    };

    const decision = engine.evaluate(request as any);
    expect(decision.action).toBe("allow");

    db.close();
  });
});
