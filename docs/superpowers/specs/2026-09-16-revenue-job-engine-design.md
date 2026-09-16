# Revenue Job Engine v1 Design

**Date:** 2026-09-16  
**Status:** Approved for implementation planning  
**Repository:** `Pritamkumarsahoo69/automaton-v2`

## Purpose

Revenue Job Engine v1 turns a paid, authorized work request into a controlled delivery workflow. It extends the existing Automaton runtime without changing its constitution, strict survival behavior, or financial policy controls.

The engine supports two types of paid work:

1. **Digital work:** research, writing, data analysis, code changes/reviews, and generated files.
2. **Hosted-service work:** a customer-paid job that produces a service or API deployed only to infrastructure controlled by the automaton.

This milestone does not promise customer acquisition or guaranteed income. It makes the runtime capable of transparently quoting, accepting, executing, documenting, and delivering legitimate paid work.

## Non-goals

- Autonomous spam, deceptive marketing, cold outreach, or fraudulent revenue generation.
- Automatic refunds or arbitrary USDC transfers to customers.
- Executing work before payment is verified.
- Giving customer text authority over the constitution, payment policy, wallet, budget, or protected files.
- Deploying services outside the automaton's owned Conway sandbox/domain boundary.
- Replacing the existing planner, orchestrator, payment rail, policy engine, or state database.

## Existing capabilities reused

| Capability | Existing location | Revenue Job Engine use |
|---|---|---|
| USDC payment requests | `src/payment/requests.ts` | Quote-to-invoice creation; verified payment gate. |
| Base USDC rail | `src/payment/usdc.ts` | Existing transfer policy boundary; no new bypass. |
| Planner and task graph | `src/orchestration/` | Plan and execute each paid job as an existing goal. |
| Financial policy | `src/agent/policy-rules/financial.ts` | Enforce spend/recipient/confirmation limits. |
| Injection defense | `src/agent/injection-defense.ts` | Sanitize customer-provided work descriptions. |
| Heartbeat | `src/heartbeat/tasks.ts` | Wake on payment; expire unpaid quotes. |
| SQLite state | `src/state/schema.ts`, `src/state/database.ts` | Persist jobs, evidence, and immutable event history. |

## Architecture

The new subsystem is `src/revenue/`. It owns job-specific rules and state, while delegating execution, payment, policy, and persistence to existing subsystems.

| Module | Single responsibility |
|---|---|
| `jobs.ts` | Create jobs and enforce their lifecycle state transitions. |
| `quotes.ts` | Lock scope/price and create a linked USDC payment request. |
| `execution.ts` | Create one orchestration goal and start it only after payment verification. |
| `delivery.ts` | Record and validate required delivery evidence. |
| `verification.ts` | Validate job type, scope, safety constraints, budgets, and evidence requirements. |
| `types.ts` | Define revenue-job types, statuses, evidence, and errors. |

### Data flow

```text
Customer/creator request
  -> validate job type + sanitize scope
  -> draft job
  -> quote locks scope, price, evidence requirements
  -> linked USDC payment request
  -> payment request marked paid
  -> job creates existing orchestration goal
  -> planner/task graph executes under job budget
  -> evidence is recorded and validated
  -> job is marked delivered
```

## Job data model

A schema migration adds `revenue_jobs` and `revenue_job_events`.

### `revenue_jobs`

| Field | Purpose |
|---|---|
| `id` | ULID job identifier. |
| `customer_address` | Customer Base address. |
| `job_type` | One allowed v1 work type. |
| `scope` | Sanitized, plain-language request. |
| `price_cents` | Agreed USDC price in cents. |
| `status` | Strict lifecycle state. |
| `payment_request_id` | Required linked invoice after quoting. |
| `goal_id` | Existing orchestration goal created after payment. |
| `budget_cents` | Maximum allowed compute/infrastructure cost. |
| `delivery_requirements` | JSON requirements derived from work type. |
| `delivery_evidence` | JSON evidence recorded at delivery. |
| `failure_reason` | Auditable terminal failure context. |
| `created_at`, `quoted_at`, `paid_at`, `started_at`, `delivered_at`, `updated_at` | Timeline/audit fields. |

Indexes support lookup by `status`, `payment_request_id`, `goal_id`, and `customer_address`.

### `revenue_job_events`

Append-only event log with job ID, prior state, next state, event type, metadata JSON, actor/source, and timestamp.

## State machine

```text
draft
  -> quoted
  -> awaiting_payment
  -> paid
  -> executing
  -> awaiting_delivery_review
  -> delivered

Terminal outcomes:
  cancelled
  expired
  failed
  refunded_pending_creator_approval
```

Allowed transitions:

| From | To | Condition |
|---|---|---|
| `draft` | `quoted` | Job validates and a quote is created. |
| `quoted` | `awaiting_payment` | A linked payment request exists. |
| `awaiting_payment` | `paid` | The exact linked request is verified paid. |
| `awaiting_payment` | `expired` | The payment request has expired. |
| `awaiting_payment` | `cancelled` | Creator cancels before execution. |
| `paid` | `executing` | Budget and safety checks pass; a goal is created. |
| `executing` | `awaiting_delivery_review` | Orchestrator reports completion. |
| `executing` | `failed` | Job execution fails or exhausts the allowed budget. |
| `awaiting_delivery_review` | `delivered` | Required evidence passes validation. |
| `awaiting_delivery_review` | `failed` | Evidence is missing/invalid after execution. |
| `delivered` | `refunded_pending_creator_approval` | A dispute is recorded; no automatic transfer occurs. |

Any other transition is rejected and audit-logged.

## Supported job types and delivery requirements

| Job type | v1 delivery evidence |
|---|---|
| `research` | Final summary/report artifact with SHA-256 hash. |
| `writing` | Final written artifact with SHA-256 hash. |
| `data_analysis` | Output file/report with SHA-256 hash and input/source summary. |
| `code_change` | Git commit hash and changed-artifact hashes. |
| `code_review` | Final review report with SHA-256 hash. |
| `file_generation` | Generated file paths and SHA-256 hashes. |
| `hosted_service` | Owned service URL, approved sandbox/domain, and passing health-check evidence. |

Delivery means the listed evidence exists and validates. It does not claim a customer accepted the result, and it does not trigger automatic refunds.

## Payment rules

1. A quote creates one linked USDC payment request.
2. The quote includes scope, price, expected delivery, and expiration.
3. A job cannot execute until its linked request is paid.
4. Revenue Job Engine never directly bypasses `send_usdc`, its financial rules, or confirmation thresholds.
5. Balance-delta matching remains insufficient for a production financial release; v1 must expose payment verification status clearly and the follow-up hardening must inspect Base USDC transfer events for sender, amount, and recipient.
6. Refunds only create `refunded_pending_creator_approval`; the creator must explicitly authorize a later transfer.

## Safety and budget rules

1. Customer content is sanitized before planner context creation.
2. Customer content is untrusted and cannot override the constitution, policy, wallet, payment destination, budget, protected source files, or system prompts.
3. Only these categories are accepted: `research`, `writing`, `data_analysis`, `code_change`, `code_review`, `file_generation`, `hosted_service`.
4. The policy engine validates planned work and tool calls as it does elsewhere in the runtime.
5. The job has an explicit maximum budget. When projected or actual spend exceeds it, the job pauses/fails without silently spending more.
6. Hosted-service jobs may deploy only to the automaton's controlled Conway sandbox and approved domain; external or unmanaged deployment targets are rejected.
7. Customer requests cannot spawn children or request funding actions.
8. The existing strict survival behavior is unchanged: zero Conway credits followed by the configured grace period transitions the agent to `dead`.

## Integration points

### Payment requests

`quote_revenue_job` creates and links a payment request. A heartbeat task evaluates paid requests and transitions eligible jobs from `awaiting_payment` to `paid`.

### Orchestration

`start_paid_job` creates exactly one existing `goals` row, with expected revenue derived from job price and an explicit budget. The current planner/orchestrator owns task decomposition, assignment, execution, and recovery.

### Heartbeat

Two new job-aware heartbeat responsibilities:

- detect/handle payment state changes for awaiting-payment jobs;
- expire unpaid jobs when their linked request expires.

The existing payment detection task remains the source of payment signals.

### Agent tools

| Tool | Behavior |
|---|---|
| `create_revenue_job` | Validate/sanitize a request and create a draft. |
| `quote_revenue_job` | Lock scope/price, create and link a payment request. |
| `start_paid_job` | Require a verified paid linked request, then create the existing orchestration goal. |
| `record_job_delivery` | Add evidence to an execution-complete job; does not bypass evidence verification. |
| `list_revenue_jobs` | Transparent job/audit inspection. |

## Error handling

- Invalid job type, malformed price, missing customer address, invalid state transition, or prohibited scope return structured errors without creating execution work.
- Failed planner/task execution produces an auditable `failed` job with reason and preserved partial artifacts.
- Payment mismatch leaves the job in `awaiting_payment`.
- Missing/invalid delivery evidence leaves the job in `awaiting_delivery_review` or transitions it to `failed`; it cannot become delivered.
- The job engine never automatically retries an expensive failed job indefinitely.

## Test plan

### State machine

- Reject invalid transitions such as `draft -> executing` and `awaiting_payment -> delivered`.
- Allow only a paid linked payment request to transition a job to `paid`.
- Persist job events for every valid and rejected state-changing request.

### Safety

- Reject unrecognized/malformed job types.
- Verify customer scope cannot mutate policy, budget, recipient, protected instructions, or wallet data.
- Reject hosted-service jobs aimed outside an owned sandbox/domain.
- Verify customer-originated work cannot cause replication/funding operations.

### Payment and execution

- Verify quoting creates a payment request linked to exactly one job.
- Verify start creates a linked orchestration goal only after verified payment.
- Verify expired payment requests expire the linked job.
- Verify budget exhaustion halts work without an additional spend.

### Delivery

- Require file hashes, Git commits, or URL/health evidence as appropriate for each job type.
- Reject delivery with missing or malformed evidence.
- Ensure disputed jobs do not initiate an automatic USDC refund.

## Delivery sequence

1. Implement the digital-work path and its evidence validation.
2. Add hosted-service jobs as the same job model with sandbox/domain and health-check constraints.
3. Only after verified delivery/reputation flows work, add transparent offer publishing or an approved marketplace integration.

This order avoids building uncontrolled outreach or infrastructure deployment before the automaton can safely fulfill paid commitments.
