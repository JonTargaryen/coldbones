# ColdBones — Database Documentation

> DynamoDB single-table design for ephemeral job tracking.

---

## Table: `coldbones-jobs`

| Property | Value |
|---|---|
| **Partition key** | `jobId` (String, UUID v4) |
| **Sort key** | *(none)* |
| **Billing mode** | PAY_PER_REQUEST (~$1.25/M writes, ~$0.25/M reads) |
| **Encryption** | AWS-managed (SSE-S3, free) |
| **PITR** | Disabled — jobs are ephemeral, no recovery value |
| **Removal policy** | RETAIN (survives `cdk destroy` to avoid accidental data loss) |

---

## Global Secondary Index

| Index | Partition Key | Sort Key | Projection |
|---|---|---|---|
| `userId-createdAt-index` | `userId` (String) | `createdAt` (String, ISO 8601) | ALL |

**Purpose:** Originally for per-user job history queries when Cognito auth was active. Auth was removed, but the GSI remains for potential future use. Not actively written to in the current auth-free codebase.

---

## Item Schema

```json
{
  "jobId": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  "status": "COMPLETED",
  "createdAt": "2025-01-15T12:34:56.789Z",
  "updatedAt": "2025-01-15T12:35:12.345Z",
  "filename": "photo.jpg",
  "s3Key": "uploads/a1b2c3d4_photo.jpg",
  "lang": "en",
  "mode": "fast",
  "provider": "bedrock-ondemand",
  "partial_text": "This image shows a...",
  "result": {
    "summary": "A detailed photograph of...",
    "description": "The image contains...",
    "insights": ["Insight 1", "Insight 2"],
    "observations": ["Obs 1", "Obs 2"],
    "ocr_text": "Any text extracted from the image",
    "content_classification": "photograph",
    "chain_of_thought": "Let me analyze this image step by step...",
    "usage": {
      "input_tokens": 1200,
      "output_tokens": 800
    },
    "processing_time_ms": 15234,
    "model": "qwen3-vl-235b",
    "provider": "bedrock-ondemand"
  },
  "error": null
}
```

---

## Status Lifecycle

```
QUEUED → PROCESSING → COMPLETED
                    → FAILED
```

| Status | Set By | Meaning |
|---|---|---|
| `QUEUED` | analyze_router | Job created, awaiting inference |
| `PROCESSING` | analyze_orchestrator / worker | Inference in progress. `partial_text` may be updated for streaming preview |
| `COMPLETED` | analyze_orchestrator / worker | Result available in `result` field |
| `FAILED` | analyze_orchestrator / worker | Error captured in `error` field |

### Status transitions:
- **Fast mode:** `QUEUED` → `PROCESSING` → `COMPLETED` (typically 5-20 seconds)
- **Slow mode (SQS):** `QUEUED` → (remains QUEUED until worker picks up) → `PROCESSING` → `COMPLETED`
- **Failure:** Any state → `FAILED` (error message stored in `error` attribute)

---

## Streaming / Partial Text

During inference, the orchestrator (or worker) periodically writes `partial_text` to DynamoDB using `UpdateItem`. The frontend polls `GET /api/status/{jobId}` every 2 seconds and renders `partial_text` as a streaming preview.

**Update pattern (Python):**
```python
table.update_item(
    Key={'jobId': job_id},
    UpdateExpression='SET #s = :s, partial_text = :pt, updatedAt = :u',
    ExpressionAttributeNames={'#s': 'status'},
    ExpressionAttributeValues={
        ':s': 'PROCESSING',
        ':pt': accumulated_text,
        ':u': now_iso,
    },
)
```

---

## Data Retention

| Data | Retention | Mechanism |
|---|---|---|
| S3 uploads | 1 day | S3 lifecycle rule (auto-expire) |
| S3 results | Indefinite | No lifecycle rule |
| DynamoDB jobs | Indefinite | No TTL configured |

**Rationale:** The upload bucket's 1-day expiry keeps storage costs near zero (~$0.023/GB/month × 0.003 days average). Result JSONs in S3 are small (<10 KB each) and retained for potential future analytics. DynamoDB items are also small (~2 KB each) and cost effectively nothing at PAY_PER_REQUEST with no reads after job completion.

---

## Capacity & Cost

| Metric | Estimate |
|---|---|
| **Writes per analysis** | 3 (QUEUED + PROCESSING + COMPLETED) |
| **Reads per analysis** | ~5-10 (frontend polls every 2s) |
| **Write cost** | $1.25/M WCU = ~$0.000004 per job |
| **Read cost** | $0.25/M RCU = ~$0.0000025 per job |
| **Storage** | ~2 KB/item, negligible at any scale |
| **Monthly cost at 1000 jobs/month** | < $0.01 |

---

## Access Patterns

| Pattern | Key | Used By |
|---|---|---|
| Create job | `PutItem(jobId)` | analyze_router |
| Update status | `UpdateItem(jobId)` | analyze_orchestrator, worker |
| Get job | `GetItem(jobId)` | job_status Lambda |
| List user jobs | `Query(userId-createdAt-index)` | *(not actively used — auth removed)* |
