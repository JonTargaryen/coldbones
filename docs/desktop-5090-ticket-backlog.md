# Coldbones Desktop 5090 Migration Ticket Backlog

This backlog translates the architecture findings into implementation tickets with concrete tasks.

## Scope

- Goal: global website + local desktop inference worker
- Model target: Qwen3.5 35B A3B multimodal, Q4 quantization path
- Primary runtime target: vLLM

## Ticket Index

| Ticket | Priority | Summary | Depends On |
|---|---|---|---|
| CB-5090-001 | P0 | Validate model/runtime compatibility and performance baseline on RTX 5090 | - |
| CB-5090-002 | P0 | Build hardened local vLLM service on desktop | CB-5090-001 |
| CB-5090-003 | P0 | Build desktop queue worker (SQS -> S3 -> vLLM -> DynamoDB) | CB-5090-002 |
| CB-5090-004 | P0 | Simplify API to async queue-first contract | CB-5090-003 |
| CB-5090-005 | P1 | Update frontend UX flow for queue-first inference | CB-5090-004 |
| CB-5090-006 | P1 | Refactor infrastructure to remove cloud GPU plane | CB-5090-004 |
| CB-5090-007 | P1 | Implement IAM/secrets hardening for desktop worker | CB-5090-003 |
| CB-5090-008 | P1 | Add observability and reliability controls | CB-5090-003 |
| CB-5090-009 | P2 | Remove legacy/duplicate lambda paths and stale code | CB-5090-004 |
| CB-5090-010 | P2 | Rewrite docs/runbooks for desktop architecture | CB-5090-006 |
| CB-5090-011 | P1 | Staging + production cutover with rollback guardrails | CB-5090-005, CB-5090-006 |

---

## CB-5090-001 — Validate model/runtime compatibility and baseline

**Objective**

Confirm the exact model artifact + quantization path can run reliably on local 5090 with expected latency/quality.

**Tasks**

- [ ] Confirm model package format and runtime compatibility matrix for chosen Q4 path.
- [ ] Benchmark text+image latency for representative image and PDF-derived page inputs.
- [ ] Measure VRAM usage, tokens/sec, and sustained throughput under queue load.
- [ ] Define production serving parameters (context len, max tokens, concurrency, batch settings).
- [ ] Document pass/fail baseline and fallback options.

**Acceptance criteria**

- [ ] Compatibility confirmed with reproducible startup command.
- [ ] Benchmark report committed with clear SLO target proposal.
- [ ] Runtime tuning parameters approved for production worker use.

---

## CB-5090-002 — Build hardened local vLLM service on desktop

**Objective**

Run vLLM as a durable local service suitable for 24/7 queue consumption.

**Tasks**

- [ ] Create desktop host bootstrap guide (driver/CUDA/runtime prerequisites).
- [ ] Add system service unit (auto-start, restart-on-failure, health checks).
- [ ] Pin model + server args for multimodal path.
- [ ] Add local health and readiness checks.
- [ ] Add local log rotation and disk-space guardrails.

**Acceptance criteria**

- [ ] Service survives reboot and restarts automatically.
- [ ] `/health` and inference endpoint stable for 24h soak test.
- [ ] Logs and failure behavior documented.

---

## CB-5090-003 — Build desktop queue worker

**Objective**

Implement worker process that executes inference jobs from SQS and writes outputs back to cloud state stores.

**Tasks**

- [ ] Create worker service folder and runtime skeleton.
- [ ] Implement SQS long polling with visibility-timeout extension.
- [ ] Download source objects from S3 and normalize image/PDF inputs.
- [ ] Call local vLLM (OpenAI-compatible API) with prompt contract.
- [ ] Persist job result to DynamoDB and optional `result.json` to S3.
- [ ] Mark job terminal state (`COMPLETED`/`FAILED`) and delete SQS message safely.
- [ ] Add poison-message handling and DLQ-safe behavior.

**Acceptance criteria**

- [ ] End-to-end async job completes without manual intervention.
- [ ] Failed jobs show deterministic error state.
- [ ] Worker idempotency verified for duplicate deliveries.

---

## CB-5090-004 — Simplify API to async queue-first contract

**Objective**

Make API a control plane only; inference execution leaves cloud.

**Tasks**

- [ ] Keep `POST /api/presign` as-is.
- [ ] Update `POST /api/analyze` to always enqueue job and return `202` + `jobId`.
- [ ] Ensure `GET /api/status/{jobId}` includes clear state transitions and result payload.
- [ ] Remove cloud-GPU-specific codepaths from analyze handlers.
- [ ] Add contract tests for API response consistency.

**Acceptance criteria**

- [ ] API no longer depends on GPU ASG or VPC GPU path.
- [ ] Fast/slow behavior either unified or clearly documented if retained.
- [ ] Existing frontend contract remains compatible or is versioned.

---

## CB-5090-005 — Update frontend for queue-first inference UX

**Objective**

Align UX with async inference and robust status progression.

**Tasks**

- [ ] Keep upload flow intact.
- [ ] Make analyze action queue-first (single path).
- [ ] Improve pending/processing/completed/failed UI messaging.
- [ ] Add timeout and retry UX for long-running jobs.
- [ ] Remove or hide unused mode toggles if no longer needed.

**Acceptance criteria**

- [ ] User can upload and receive result through polling path only.
- [ ] UI states match backend job state transitions.

---

## CB-5090-006 — Refactor infrastructure to remove cloud GPU plane

**Objective**

Reduce cost and complexity by eliminating cloud GPU resources.

**Tasks**

- [ ] Remove network and cloud-GPU stack dependencies from app composition.
- [ ] Keep Storage/Queue/API stacks required for global availability.
- [ ] Remove lifecycle/scheduler lambda deployment wiring not required post-cutover.
- [ ] Update deploy/status scripts to reflect new minimal stack set.
- [ ] Validate `cdk synth/diff/deploy` in staging account.

**Acceptance criteria**

- [ ] No cloud GPU stack required for successful deployment.
- [ ] Global web app and API remain reachable.
- [ ] Monthly cost profile reduced as expected.

---

## CB-5090-007 — IAM and secrets hardening for desktop worker

**Objective**

Secure desktop-cloud integration with least privilege and auditable access.

**Tasks**

- [ ] Create dedicated IAM principal for worker with scoped policies.
- [ ] Restrict S3 prefixes and DynamoDB table actions.
- [ ] Add key rotation and secret handling runbook.
- [ ] Add CloudTrail/CloudWatch alerting for unusual access patterns.

**Acceptance criteria**

- [ ] Worker permissions are minimal and documented.
- [ ] Rotating credentials does not require downtime.

---

## CB-5090-008 — Observability and reliability controls

**Objective**

Make desktop-backed inference operable in production.

**Tasks**

- [ ] Emit worker heartbeat metric and liveness timestamp.
- [ ] Add queue depth alarm and stale-job alarm.
- [ ] Add result latency and failure-rate dashboards.
- [ ] Define auto-pause behavior when desktop unavailable.
- [ ] Add retry budgets and dead-letter triage process.

**Acceptance criteria**

- [ ] On-call can detect worker outage in under 5 minutes.
- [ ] Queue backlog and error rate are visible in one dashboard.

---

## CB-5090-009 — Remove legacy/duplicate code paths

**Objective**

Reduce maintenance risk by deleting stale handlers and duplicated logic.

**Tasks**

- [ ] Remove legacy LM Studio code blocks from inference lambdas.
- [ ] Deduplicate duplicated handler definitions in affected lambda files.
- [ ] Remove obsolete GPU lifecycle code if stack no longer used.
- [ ] Add lint/test guardrails to prevent duplicate handlers reappearing.

**Acceptance criteria**

- [ ] Single authoritative handler per lambda file.
- [ ] No dead references to removed GPU cloud controls.

---

## CB-5090-010 — Rewrite docs and runbooks

**Objective**

Align onboarding and operations with desktop-backed architecture.

**Tasks**

- [ ] Rewrite architecture section and data flow diagrams.
- [ ] Add desktop worker setup and incident runbooks.
- [ ] Add “what to do if desktop is offline” operational procedure.
- [ ] Update validation scripts documentation and expected outputs.

**Acceptance criteria**

- [ ] New engineer can deploy and validate end-to-end from docs only.
- [ ] Incident response steps are explicit and tested.

---

## CB-5090-011 — Staging and production cutover

**Objective**

Cut over safely with rollback ability.

**Tasks**

- [ ] Deploy staging with desktop worker connected.
- [ ] Run end-to-end functional + load validation.
- [ ] Freeze old cloud GPU path behind feature flag or route switch.
- [ ] Execute production cutover window with monitoring war-room checklist.
- [ ] Verify rollback script/path before declaring success.

**Acceptance criteria**

- [ ] Production traffic served successfully through desktop worker path.
- [ ] Rollback tested and documented.
- [ ] Post-cutover review completed with cost/perf report.

---

## Suggested Milestones

- **Milestone A (P0):** CB-5090-001..004 complete (functional queue-first desktop inference)
- **Milestone B (P1):** CB-5090-005..008 complete (operable production posture)
- **Milestone C (P2):** CB-5090-009..011 complete (cleanup + docs + hardened cutover)

## MultiSwarm Execution

- Source of truth board: `multiswarm/tickets.json`
- Agent roster: `multiswarm/agents.json`
- Shared variable contract: `multiswarm/variables.json`
- Coordination CLI: `scripts/multiswarm.py`
