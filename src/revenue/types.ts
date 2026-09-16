export const REVENUE_JOB_TYPES = [
  "research", "writing", "data_analysis", "code_change",
  "code_review", "file_generation", "hosted_service",
] as const;
export type RevenueJobType = typeof REVENUE_JOB_TYPES[number];

export const REVENUE_JOB_STATUSES = [
  "draft", "quoted", "awaiting_payment", "paid", "executing",
  "awaiting_delivery_review", "delivered", "cancelled", "expired",
  "failed", "refunded_pending_creator_approval",
] as const;
export type RevenueJobStatus = typeof REVENUE_JOB_STATUSES[number];

export interface RevenuePolicy {
  enabled: boolean;
  maxJobBudgetCents: number;
  maxActiveJobs: number;
  allowedJobTypes: RevenueJobType[];
  ownedServiceDomains: string[];
  deliveryRoot: string;
  requiredPaymentConfirmations: number;
}

export const DEFAULT_REVENUE_POLICY: RevenuePolicy = {
  enabled: false,
  maxJobBudgetCents: 10_000,
  maxActiveJobs: 1,
  allowedJobTypes: [...REVENUE_JOB_TYPES],
  ownedServiceDomains: [],
  deliveryRoot: "~/.automaton/deliveries",
  requiredPaymentConfirmations: 3,
};

export type DeliveryEvidenceKind = "file" | "url" | "hosted_endpoint";

export interface DeliveryEvidence {
  kind: DeliveryEvidenceKind;
  ref: string;
  checksum?: string;
  mimeType?: string;
  label?: string;
}

export interface RevenueJob {
  id: string;
  customerAddress: string;
  jobType: RevenueJobType;
  scope: string;
  priceCents: number;
  budgetCents: number;
  status: RevenueJobStatus;
  paymentRequestId?: string;
  goalId?: string;
  deliveryRequirements: Record<string, unknown>;
  deliveryEvidence: DeliveryEvidence[];
  failureReason?: string;
  createdAt: string;
  quotedAt?: string;
  paidAt?: string;
  startedAt?: string;
  deliveredAt?: string;
  updatedAt: string;
}

export interface RevenueJobEvent {
  id: string;
  jobId: string;
  fromStatus?: RevenueJobStatus;
  toStatus: RevenueJobStatus;
  eventType: string;
  metadata: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

export interface CreateRevenueJobInput {
  customerAddress: string;
  jobType: RevenueJobType;
  scope: string;
  priceCents: number;
  budgetCents?: number;
  deliveryRequirements?: Record<string, unknown>;
}

export interface QuoteRevenueJobInput {
  jobId: string;
  priceCents: number;
  budgetCents?: number;
  paymentRequestId?: string;
}
