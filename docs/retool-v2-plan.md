# Coldbones Retool V2 Plan

## Decisions Locked

- Track: Hybrid V2 (parallel rebuild)
- Priority: AWS infrastructure foundation first
- Milestone 1: reliable upload → analyze → result flow

## V2 Stack Map

1. `ColdbonesV2Foundation`
   - Upload bucket, site bucket, jobs table
2. `ColdbonesV2Messaging`
   - Main analysis queue, DLQ, notifications topic
3. `ColdbonesV2Runtime`
   - VPC, lambda/gpu security groups, GPU endpoint SSM parameters
4. `ColdbonesV2Api`
   - V2 API baseline and health endpoint

## Phase Plan

### Phase 0 — Foundation Baseline

- Scaffold `infrastructure-v2` as independent CDK app
- Deploy V2 stacks without touching current production stack names
- Add scripts for deploy and status checks

Exit criteria:

- V2 stacks are deployable independently
- CloudFormation status is visible from one command
- V2 API health endpoint responds successfully

### Phase 1 — Ingestion Slice

- Implement `POST /api/presign` in V2 API
- Enforce file constraints and metadata schema
- Store job records in V2 DynamoDB

Exit criteria:

- Client can upload directly to V2 S3 using presigned URL
- Job record is persisted and queryable

### Phase 2 — Analyze Slice

- Implement `POST /api/analyze` route in V2 API
- Route fast mode to sync runtime path
- Route slow mode to SQS path with worker processing

Exit criteria:

- Analyze flow returns deterministic job/result contract
- Failures are recoverable and visible in DLQ/metrics

### Phase 3 — Result and Readiness

- Implement `GET /api/status/{jobId}` in V2 API
- Add end-to-end validation script for V2 path
- Add alarms and dashboard for API, queue, and runtime health

Exit criteria:

- Upload → analyze → result works in V2 without manual intervention
- Rollback path to current stack remains available

## Next Build Targets

1. Add V2 API contract (`presign`, `analyze`, `status`)
2. Stand up worker lambda for queue jobs
3. Wire runtime service discovery from V2 SSM parameters
4. Add integration test for milestone 1 flow