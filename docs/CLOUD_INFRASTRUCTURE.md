# ColdBones — Cloud Infrastructure Documentation

> AWS CDK (TypeScript) — 3 stacks deployed to us-east-1.

---

## Stack Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ bin/app.ts                                                          │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ ColdbonesStorage │  │ ColdbonesQueue│  │    ColdbonesApi       │ │
│  │   (Stack 1)      │  │   (Stack 2)   │  │    (Stack 3)          │ │
│  │                  │  │               │  │                       │ │
│  │  S3 (uploads)    │  │  SQS queue    │  │  HTTP API Gateway v2  │ │
│  │  S3 (site)       │  │  SQS DLQ     │  │  Lambda: presign      │ │
│  │  CloudFront      │  │  SNS topic    │  │  Lambda: router       │ │
│  │  WAF v2          │  │               │  │  Lambda: orchestrator │ │
│  │  Route53         │  │               │  │  Lambda: batch_proc   │ │
│  │  ACM cert        │  │               │  │  Lambda: job_status   │ │
│  │  DynamoDB        │  │               │  │  Lambda: health       │ │
│  │  Cognito (kept)  │  │               │  │  CloudWatch alarms    │ │
│  └──────────────────┘  └──────────────┘  │  Synthetics canary     │ │
│                                           └───────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Stack 1: StorageStack (`lib/storage-stack.ts`)

Owns all persistent and serving infrastructure. Deployed first because ApiStack Lambdas need bucket names and table ARNs.

### S3: Upload Bucket

| Property | Value |
|---|---|
| **Name** | `coldbones-uploads-*` (CDK-generated suffix) |
| **Encryption** | S3-managed (SSE-S3) |
| **Public access** | BLOCK_ALL |
| **Versioning** | Disabled |
| **Lifecycle** | Uploads expire after 1 day; incomplete multipart aborted after 1 day |
| **CORS** | PUT, HEAD from `app.omlahiri.com`, `localhost:5173` |
| **Removal** | RETAIN |

**Design:** Separate from site bucket so different lifecycle/CORS rules apply independently. CloudFront serves the site bucket without risk of exposing raw uploads.

### S3: Site Bucket

| Property | Value |
|---|---|
| **Name** | `coldbones-site-*` |
| **Encryption** | S3-managed |
| **Public access** | BLOCK_ALL (OAC-only access) |
| **Versioning** | Disabled (SPA builds are fully reproducible) |
| **Removal** | RETAIN |

### CloudFront Distribution

| Property | Value |
|---|---|
| **Origin** | S3 via Origin Access Control (OAC) |
| **Default behavior** | GET/HEAD/OPTIONS, CACHING_OPTIMIZED, gzip/brotli |
| **Error pages** | 403→`/index.html` (200), 404→`/index.html` (200) for SPA routing |
| **Price class** | PRICE_CLASS_100 (US, Canada, Europe — cheapest) |
| **Domain names** | `app.omlahiri.com`, `www.omlahiri.com`, `omlahiri.com` |
| **WAF** | Attached (see below) |
| **API routing** | `/api/*` behavior → API Gateway origin via path pattern |

**Security Headers (ResponseHeadersPolicy):**
- `Content-Security-Policy`: strict CSP — `default-src 'self'`, script/connect/font/style scoped
- `X-Content-Type-Options`: `nosniff`
- `X-Frame-Options`: `DENY`
- `Referrer-Policy`: `strict-origin-when-cross-origin`
- `Strict-Transport-Security`: HSTS enabled

### WAF v2 (Web Application Firewall)

Attached to CloudFront distribution. Scope: CLOUDFRONT.

| Rule | Priority | Type | Description |
|---|---|---|---|
| `AWSManagedRulesCommonRuleSet` | 10 | Managed | Blocks bad user agents, path traversal, etc. |
| `AWSManagedRulesKnownBadInputsRuleSet` | 20 | Managed | Blocks exploitation patterns |
| `AWSManagedRulesSQLiRuleSet` | 30 | Managed | SQL injection protection |
| `RateLimitPerIP` | 40 | Rate-based | 500 requests per 5 min per IP |

**Cost:** ~$5/month base + $0.60/million requests evaluated.

### Route53

| Record | Type | Target |
|---|---|---|
| `app.omlahiri.com` | A (alias) | CloudFront distribution |
| `www.omlahiri.com` | A (alias) | CloudFront distribution |
| `omlahiri.com` (apex) | A (alias) | CloudFront distribution |

**Name servers:** Output as `HostedZoneNameServers` for Squarespace DNS configuration.

### ACM Certificate

| Property | Value |
|---|---|
| **Domain** | `omlahiri.com` |
| **SANs** | `*.omlahiri.com` |
| **Validation** | DNS (Route53) |
| **Region** | us-east-1 (required for CloudFront) |

### DynamoDB

See [DATABASE.md](DATABASE.md) for full schema documentation.

### Cognito User Pool

Present in CDK but authentication was removed from the API. The pool still exists for potential future use.

---

## Stack 2: QueueStack (`lib/queue-stack.ts`)

Async work delivery for slow-mode analysis.

### SQS: Analysis Queue

| Property | Value |
|---|---|
| **Name** | `coldbones-analysis` |
| **Encryption** | SQS-managed |
| **Visibility timeout** | 16 minutes (≥ Lambda timeout of 15 min) |
| **Retention** | 4 days |
| **Long polling** | 20 seconds |
| **Dead letter queue** | `coldbones-analysis-dlq` (maxReceiveCount: 3) |

### SQS: Dead Letter Queue

| Property | Value |
|---|---|
| **Name** | `coldbones-analysis-dlq` |
| **Encryption** | SQS-managed |
| **Retention** | 14 days |

**Purpose:** Messages that fail processing 3 times are moved here for investigation.

### SNS: Notification Topic

| Property | Value |
|---|---|
| **Name** | `coldbones-notifications` |
| **Purpose** | Future: email/push alerts on job completion |

---

## Stack 3: ApiStack (`lib/api-stack.ts`)

Compute (Lambda functions) and API routing.

### HTTP API Gateway v2

| Property | Value |
|---|---|
| **Type** | HTTP API (71% cheaper than REST API: $1.00 vs $3.50/M requests) |
| **Stage** | `v1` (keeps CloudFront `originPath: '/v1'` unchanged) |
| **CORS** | All origins, methods, headers |

**Routes:**

| Method | Path | Lambda | Timeout | Memory |
|---|---|---|---|---|
| POST | `/api/presign` | get_presigned_url | 10s | 128 MB |
| POST | `/api/analyze` | analyze_router | 30s | 256 MB |
| GET | `/api/status/{jobId}` | job_status | 10s | 128 MB |
| GET | `/api/health` | health (inline) | 5s | 128 MB |

**Not routed (async invoke):**

| Lambda | Trigger | Timeout | Memory |
|---|---|---|---|
| analyze_orchestrator | Lambda.Invoke from router | 10 min | 256 MB |
| batch_processor | SQS trigger (batchSize=1) | 15 min | 256 MB |

### Lambda Configuration (all functions)

| Property | Value |
|---|---|
| **Runtime** | Python 3.12 |
| **Architecture** | ARM64 (Graviton2) — 20% cheaper per GB-second |
| **Log retention** | 30 days |
| **Tracing** | AWS X-Ray (active) |
| **Bundling** | pip install to asset + copy shared clients |

### Shared IAM Role

All Lambdas share a single role with these permissions:

| Permission | Resource |
|---|---|
| `AWSLambdaBasicExecutionRole` | CloudWatch Logs |
| `AWSXRayDaemonWriteAccess` | X-Ray traces |
| S3 ReadWrite | Upload bucket |
| DynamoDB ReadWrite | Jobs table |
| SQS SendMessages | Analysis queue |
| SSM GetParameter | `/coldbones/*` |
| Bedrock InvokeModel | `qwen.qwen3-vl-235b-a22b` |
| Lambda Invoke | Orchestrator function |

### CloudWatch Alarms

| Alarm | Metric | Threshold | Action |
|---|---|---|---|
| Router 5xx | `5XXError` | ≥1 in 1 min | SNS → email |
| Orchestrator errors | `Errors` | ≥3 in 5 min | SNS → email |
| DLQ depth | `ApproximateNumberOfMessagesVisible` | ≥1 | SNS → email |

### Synthetics Canary

| Property | Value |
|---|---|
| **Schedule** | Every 5 minutes |
| **Script** | Calls `/api/health`, verifies 200 + `status: ok` |
| **Alarm** | `SuccessPercent < 90%` in 15 min → SNS → email |

---

## Deployment

### Scripts

| Script | Purpose |
|---|---|
| `scripts/deploy.sh` | Full CDK deploy (all 3 stacks) |
| `scripts/deploy-frontend.sh` | Build frontend + S3 sync + CloudFront invalidation |
| `scripts/spin-up.sh` | Deploy infrastructure |
| `scripts/spin-down.sh` | Destroy infrastructure (cost savings) |
| `scripts/teardown.sh` | Full teardown |
| `scripts/validate.sh` | Post-deploy validation |
| `scripts/setup-bedrock-model.sh` | Import Bedrock custom model (legacy CMI) |

### CDK Context (`cdk.json`)

```json
{
  "coldbones": {
    "domainName": "omlahiri.com",
    "appSubdomain": "app",
    "modelName": "Qwen/Qwen3.5-35B-A3B-AWQ",
    "apiGatewayDomain": "<from first deploy>",
    "apiGatewayStageName": "v1"
  }
}
```

### Cross-Stack Dependencies

```
StorageStack ──exports──→ ApiStack
  uploadBucket               (Lambda env vars)
  jobsTable                  (Lambda env vars)

QueueStack ──exports──→ ApiStack
  analysisQueue              (Lambda env vars, SQS trigger)
```

---

## Cost Estimate (Monthly)

| Service | Estimate | Notes |
|---|---|---|
| CloudFront | $0-1 | PRICE_CLASS_100, ~1 GB transfer |
| S3 | < $0.10 | Uploads expire in 1 day |
| DynamoDB | < $0.01 | PAY_PER_REQUEST, small items |
| Lambda | $0-0.50 | ARM64, short runtimes |
| API Gateway v2 | < $0.01 | $1/M requests |
| WAF | ~$5 | Base fee + rules |
| Route53 | $0.50 | Hosted zone |
| ACM | Free | Public certificates |
| CloudWatch | ~$0.50 | Logs + alarms |
| Synthetics | ~$0.10 | 1 canary |
| **Total (infra only)** | **~$6-8** | Excludes Bedrock inference |
