# ColdBones — Development History

> Timeline of the project from initial commit to 1.0 release.

---

## Project Timeline

### Day 1 — March 3, 2026: Foundation

| Commit | Description |
|---|---|
| `a8fe561` | **Initial commit** — project scaffolding |
| `2599a54` | **Initial plan** — architecture design document |
| `30f91c8` | **WebSocket notification handler** — SNS-based job completion (later simplified to polling) |
| `93287e5` → `fede363` | Exploration branch: local-only (no AWS) variant, abandoned in favor of hybrid approach |

**Key decisions made:**
- React + TypeScript + Vite frontend
- AWS CDK for infrastructure-as-code
- Python Lambdas on ARM64 Graviton2 (cost optimization)
- S3 presigned URLs for direct browser uploads (no proxy overhead)
- DynamoDB for job tracking with TTL auto-cleanup

### Day 2 — March 4, 2026: Core Implementation

| Commit | Description |
|---|---|
| `7444bbc` | **Tests + CDK stacks + Lambda setup** — initial test infrastructure, context/validation tests, CDK stack assertions |
| `1b596be` → `26e6954` | Rapid iteration on Lambda handlers (presign, analyze router, job status) |
| `6e7f4b1` | **Local development features** — file uploads, analysis flow, Lambda function setup, model name caching |
| `68d973e` → `f33b7b3` | Frontend components: UploadZone, FilePreview, AnalysisPanel, JobTracker |
| `2d3d367` | Experimental branch: alternative worker approach |
| `9ea0fa9` → `bf48d36` | Provider routing, health checks, mode toggle, language picker |
| `7e6923e` | **Code cleanup** — consolidation of rapid development artifacts |
| `fa4cd1d` | **LM Studio API key authentication** — API key support for secured endpoints |
| `8726092` | **Revert API key auth** — removed in favor of WAF rate limiting (simpler, sufficient for portfolio) |

**Architectural evolution on Day 2:**
- Started with WebSocket notifications, pivoted to setInterval polling (simpler, more reliable)
- Authentication was added then reverted — WAF rate limiting chosen as the security model
- Dual-mode (fast/slow) architecture solidified
- Desktop worker (SQS long-poller) implemented
- Three inference providers wired: Bedrock On-Demand, Desktop (LM Studio), Bedrock CMI

### Day 3 — March 5, 2026: Polish & 1.0 Prep

| Commit | Description |
|---|---|
| `77a5fe9` | **Project initialization scripts** — deploy.sh, teardown.sh, spin-up/down, validate.sh |
| `df653d3` | **Package.json cleanup** — removed husky, streamlined scripts |
| `fa9d917` | **CSP fix** — Content Security Policy updated for Google Fonts + S3 |
| `160ae3a` | Infrastructure configuration refinements |
| `ab3bb21` | **Live streaming preview** — partialText shown during analysis (model output streamed token-by-token) |
| `59dd45d` | **Major refactor** — code structure improved for readability and maintainability |
| `6f942b0` | **Video support** — 40MB video file testing, frame extraction pipeline |
| `275b8a0` | **Remove "RTX 5090" branding** — subtitle removed from all 4 locales |

**1.0 release work (this session):**
- Backend tests: 0% → **95.19% coverage** (228 tests)
- Frontend tests: ~48% → **97.65% statements, 91.10% branches** (352 tests)
- All 4 coverage thresholds passing (97/90/97/97)
- Comprehensive documentation created

---

## Architecture Decision Records

### ADR 1: Polling vs WebSockets
- **Chose**: setInterval polling (3s fast, 4s slow)
- **Why**: Simpler implementation, no WebSocket infra needed, HTTP API v2 doesn't support WebSockets, sufficient for single-user usage patterns
- **Tradeoff**: Slight latency (up to 3s after completion), unnecessary requests during processing

### ADR 2: Direct S3 Upload vs API Proxy
- **Chose**: Presigned URLs + direct XHR PUT to S3
- **Why**: No file bytes flow through Lambda (saves cost + avoids 6MB Lambda payload limit), XHR provides upload progress events
- **Tradeoff**: Two-step flow (presign then upload), CORS configuration required on S3

### ADR 3: HTTP API v2 vs REST API
- **Chose**: HTTP API v2
- **Why**: 71% cheaper, lower latency, built-in CORS, sufficient for simple routing
- **Tradeoff**: Fewer features (no request validation, no usage plans)

### ADR 4: ARM64 Graviton2 Lambda
- **Chose**: ARM64 architecture for all Lambdas
- **Why**: 20% cheaper than x86, better price-performance, Python is architecture-agnostic
- **Tradeoff**: Must ensure all Lambda dependencies compile for ARM64

### ADR 5: DynamoDB over RDS/Aurora
- **Chose**: DynamoDB with PAY_PER_REQUEST
- **Why**: Zero-cost at idle, no connection pooling needed, single-table design is sufficient (only job status tracking)
- **Tradeoff**: No relational queries, limited to key-value access patterns

### ADR 6: No Authentication
- **Chose**: Public API with WAF rate limiting
- **Why**: Portfolio project — authentication adds friction for reviewers/evaluators, WAF prevents abuse
- **Tradeoff**: Anyone can use the API (intentional), cost controlled by WAF rate limiting

### ADR 7: Bedrock On-Demand as Default (over CMI)
- **Chose**: Bedrock Converse API with Qwen3 VL 235B
- **Why**: Pay-per-token ($0.003/image), no cold start, no infrastructure, scale-to-zero. CMI charges 5-min windows.
- **Tradeoff**: ~$0.35/M input + $1.40/M output tokens (still far cheaper than CMI for sporadic usage)

### ADR 8: Desktop Worker via Tailscale
- **Chose**: Tailscale Funnel for home GPU exposure
- **Why**: No public IP needed, automatic TLS, survives IP changes, zero-config NAT traversal
- **Tradeoff**: Depends on Tailscale service availability, adds ~10ms latency

---

## Metrics at 1.0

| Metric | Value |
|---|---|
| Total commits | 37 |
| Development time | 3 days |
| Files changed | 149 |
| Lines added | ~36,000 |
| Frontend test count | 352 |
| Frontend statement coverage | 97.65% |
| Frontend branch coverage | 91.10% |
| Backend test count | 228 |
| Backend coverage | 95.19% |
| Languages supported | 4 (en, hi, es, bn) |
| Inference providers | 3 (Bedrock OD, Desktop, Bedrock CMI) |
| AWS Lambda functions | 5 |
| CDK stacks | 3 |
| Processing modes | 2 (fast, slow) |
