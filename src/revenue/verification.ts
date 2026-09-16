/**
 * Revenue Job Validation
 *
 * Validates job input (scope sanitization, budget checks, job type
 * eligibility) and derives deterministic delivery requirements per job type.
 */

import type { Address } from "viem";
import { isValidEvmAddress } from "../identity/chain.js";
import { sanitizeInput } from "../agent/injection-defense.js";
import type {
  RevenueJobType,
  RevenuePolicy,
  CreateRevenueJobInput,
  DeliveryEvidence,
} from "./types.js";

export class RevenueJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RevenueJobError";
  }
}

export interface ValidatedJobInput {
  customerAddress: Address;
  jobType: RevenueJobType;
  scope: string;
  priceCents: number;
  budgetCents: number;
  deliveryRequirements: Record<string, unknown>;
}

/**
 * Validate and sanitize revenue job input.
 * Throws RevenueJobError on any validation failure.
 */
export function validateRevenueJobInput(
  input: CreateRevenueJobInput,
  policy: RevenuePolicy,
): ValidatedJobInput {
  // Revenue must be explicitly enabled
  if (!policy.enabled) {
    throw new RevenueJobError("REVENUE_DISABLED", "Revenue job engine is disabled");
  }

  // Validate customer address
  if (!isValidEvmAddress(input.customerAddress)) {
    throw new RevenueJobError("INVALID_ADDRESS", `Invalid Base address: ${input.customerAddress}`);
  }

  // Validate job type
  const validTypes = ["research", "writing", "data_analysis", "code_change", "code_review", "file_generation", "hosted_service"] as const;
  if (!validTypes.includes(input.jobType)) {
    throw new RevenueJobError("INVALID_JOB_TYPE", `Unknown job type: ${input.jobType}`);
  }
  if (!policy.allowedJobTypes.includes(input.jobType)) {
    throw new RevenueJobError("JOB_TYPE_NOT_ALLOWED", `Job type "${input.jobType}" not allowed by policy`);
  }

  // Sanitize scope — customer text is untrusted
  const sanitized = sanitizeInput(input.scope, input.customerAddress, "social_message");
  if (sanitized.blocked) {
    throw new RevenueJobError("SCOPE_BLOCKED", `Customer scope blocked by injection defense: ${sanitized.threatLevel}`);
  }

  // Validate price
  const priceCents = input.priceCents;
  if (!Number.isInteger(priceCents) || priceCents <= 0 || !Number.isSafeInteger(priceCents)) {
    throw new RevenueJobError("INVALID_PRICE", `price_cents must be a positive safe integer, got ${priceCents}`);
  }

  // Validate budget
  const budgetCents = input.budgetCents ?? Math.min(priceCents, 500); // default to min of price or $5
  if (!Number.isInteger(budgetCents) || budgetCents < 0 || !Number.isSafeInteger(budgetCents)) {
    throw new RevenueJobError("INVALID_BUDGET", `budget_cents must be a non-negative safe integer, got ${budgetCents}`);
  }
  if (budgetCents > policy.maxJobBudgetCents) {
    throw new RevenueJobError("BUDGET_EXCEEDED", `budget ${budgetCents}¢ exceeds max ${policy.maxJobBudgetCents}¢`);
  }

  // Derive delivery requirements based on job type
  const deliveryRequirements = deriveDeliveryRequirements(input.jobType, policy);

  // Hosted service requires at least one owned domain
  if (input.jobType === "hosted_service" && policy.ownedServiceDomains.length === 0) {
    throw new RevenueJobError("NO_OWNED_DOMAINS", "Hosted service jobs require at least one ownedServiceDomain");
  }

  return {
    customerAddress: input.customerAddress as Address,
    jobType: input.jobType,
    scope: sanitized.content,
    priceCents,
    budgetCents,
    deliveryRequirements,
  };
}

/**
 * Derive deterministic delivery requirements based on job type.
 */
export function deriveDeliveryRequirements(
  jobType: RevenueJobType,
  policy: RevenuePolicy,
): Record<string, unknown> {
  switch (jobType) {
    case "research":
    case "writing":
    case "code_review":
    case "file_generation":
      return { kind: "file_hash" };
    case "data_analysis":
      return { kind: "data_report" };
    case "code_change":
      return { kind: "git_commit_and_hashes" };
    case "hosted_service":
      return {
        kind: "owned_service_health",
        requiredDomains: policy.ownedServiceDomains,
      };
    default:
      return { kind: "unknown" };
  }
}

/**
 * Validate delivery evidence shape for a given job type.
 * Returns true if the evidence is structurally valid.
 */
export function validateDeliveryEvidence(
  evidence: unknown[],
  jobType: RevenueJobType,
  policy: RevenuePolicy,
  identity?: { sandboxId: string },
): string | null {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return "Evidence must be a non-empty array";
  }

  const requiredKeys = new Set<string>();
  const optionalKeys = new Set<string>();

  switch (jobType) {
    case "research":
    case "writing":
    case "code_review":
    case "file_generation":
      requiredKeys.add("file");
      optionalKeys.add("mimeType");
      break;
    case "data_analysis":
      requiredKeys.add("file");
      requiredKeys.add("source_summary");
      break;
    case "code_change":
      requiredKeys.add("git_commit");
      requiredKeys.add("file");
      break;
    case "hosted_service":
      requiredKeys.add("service");
      break;
    default:
      return `Unknown job type: ${jobType}`;
  }

  const foundKeys = new Set<string>();
  for (const item of evidence) {
    if (item && typeof item === "object" && "kind" in item) {
      foundKeys.add((item as { kind: string }).kind);
    }
  }

  for (const key of requiredKeys) {
    if (!foundKeys.has(key)) {
      return `Missing required evidence kind: ${key}`;
    }
  }

  // Hosted service: validate sandboxId and domain
  if (jobType === "hosted_service") {
    const serviceEvidence = evidence.find(
      (e) => e && typeof e === "object" && (e as any).kind === "service",
    ) as any;
    if (serviceEvidence) {
      if (identity && serviceEvidence.sandboxId !== identity.sandboxId) {
        return "Service sandboxId does not match automaton identity";
      }
      const url = serviceEvidence.url as string;
      if (!url.startsWith("https://")) {
        return "Service URL must use https:";
      }
      const hostname = new URL(url).hostname;
      const isOwned = policy.ownedServiceDomains.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      );
      if (!isOwned) {
        return `Service hostname "${hostname}" is not in ownedServiceDomains: ${policy.ownedServiceDomains.join(", ")}`;
      }
    }
  }

  return null;
}
