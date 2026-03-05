# Bedrock — Architecture, Categories, Custom Model Import & Cost Comparison

---

## 1. How Amazon Bedrock Works

Amazon Bedrock is a **fully managed service** for building generative AI applications. It provides a unified API to access foundation models (FMs) from multiple providers, with zero infrastructure to manage.

### Core Architecture

```
Your App → AWS SDK / API Gateway → Bedrock API → Model Execution (AWS-managed GPU fleet)
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
              On-Demand          Provisioned         Custom Model
            (pay-per-token)     Throughput           Import (CMI)
                                (reserved)          (your weights)
```

**Key principles:**
- **No infrastructure management** — AWS handles GPU allocation, scaling, patching
- **Pay-per-use** — on-demand pricing charges per input/output token (or per 5-min window for CMI)
- **Multi-provider** — single API to access models from Amazon, Anthropic, Meta, Mistral, Cohere, etc.
- **Private** — your data is never used to train models; model traffic stays within your VPC

---

## 2. All Bedrock Categories / Features

### Model Access & Inference

| Category | Description | Pricing Model |
|---|---|---|
| **On-Demand Inference** | Per-token pricing, no commitment. Call `InvokeModel` / `Converse` API | Per 1K input/output tokens |
| **Batch Inference** | Process large datasets offline at 50% discount vs on-demand | Per 1K tokens (50% off) |
| **Provisioned Throughput** | Reserved capacity for consistent performance. Billed hourly per Model Unit | Hourly per model unit (1m/6m commitment) |
| **Cross-Region Inference** | Auto-route requests to regions with capacity | Same as on-demand |
| **Intelligent Prompt Routing** | Routes between models based on complexity | Per 1K tokens |

### Model Customization

| Category | Description | Pricing Model |
|---|---|---|
| **Fine-Tuning** | Customize base models with your data (LoRA, full) | Per 1K tokens processed during training |
| **Continued Pre-Training** | Extend model knowledge with domain data | Per 1K tokens |
| **Custom Model Import (CMI)** | Bring your own model weights (Hugging Face format) | Per 5-min active window + storage |
| **Model Distillation** | Create smaller models from larger teacher models | Per 1K tokens |

### Application Features

| Category | Description | Pricing Model |
|---|---|---|
| **Knowledge Bases** | RAG with managed vector DB (OpenSearch, Pinecone, etc.) | Per retrieval + embedding tokens |
| **Agents** | Multi-step autonomous agents with tool use | Per invocation + model tokens |
| **Flows** | Visual workflow orchestration of model chains | Per node transition |
| **Guardrails** | Content filters, PII redaction, denied topics | Per 1K text units |
| **Data Automation** | Document/image/video extraction and processing | Per page/minute/image |
| **Prompt Management** | Version, optimize, and A/B test prompts | Per token for optimization |
| **Model Evaluation** | Automatic & human-based model comparison | Model inference + per human task |

### Service Tiers

| Tier | Description |
|---|---|
| **Standard** | Default on-demand pricing |
| **Flex** | Lower cost, best-effort processing (may queue during peak) |
| **Priority** | Guaranteed low-latency for mission-critical workloads |
| **Reserved** | 1-month or 6-month commitment for predictable throughput |

### Supported Model Providers (on-demand)

AI21 Labs, Amazon (Titan, Nova), Anthropic (Claude), Cohere, DeepSeek, Google, Luma AI, Meta (Llama), MiniMax AI, Mistral AI, Moonshot AI, NVIDIA, OpenAI, **Qwen**, Stability AI, TwelveLabs, Writer, Z AI

---

## 3. Custom Model Import (CMI) — Deep Dive

### What It Is
CMI lets you bring your own model weights (trained externally, fine-tuned, or from Hugging Face) and run them on Bedrock's managed infrastructure. You get the same `InvokeModel` API, auto-scaling, and security as native Bedrock models.

### How It Works

```
1. Upload model weights to S3 (safetensors format)
2. Call CreateModelImportJob (or use console)
3. Bedrock validates architecture + allocates CMUs
4. Model is "imported" — available via InvokeModel API
5. First invocation "warms" the model (~30-60s cold start)
6. Billed per 5-minute active window, auto-scales to zero
```

### Supported Architectures (as of March 2026)

| Architecture | Examples | Vision Support |
|---|---|---|
| **LLaMA** | Llama 2, Llama 3, Llama 3.1, Llama 3.2, Llama 3.3 | Text only |
| **Mistral** | Mistral 7B, Mixtral 8x7B, Mistral Large | Text only |
| **Falcon** | Falcon 7B, 40B, 180B | Text only |
| **Qwen2** | Qwen2-7B, Qwen2-72B | Text only |
| **Qwen2_VL** | Qwen2-VL-7B | ✅ Vision-Language |
| **Qwen2_5_VL** | Qwen2.5-VL-7B-Instruct, 32B, 72B | ✅ Vision-Language |

> **Important:** Qwen 3.5 (our current desktop model) architecture is NOT yet supported.
> The closest supported vision-language model is **Qwen2.5-VL-7B-Instruct**.

### CMI Pricing

| Component | Cost | Notes |
|---|---|---|
| **Import** | Free | No charge for import job |
| **Storage** | ~$1.95/month per CMU | While model exists |
| **Inference** | ~$0.0785/min per CMU | Billed in 5-min windows |
| **Cold start** | 30-60 seconds | First invocation after idle |
| **Scale-to-zero** | Automatic | No charge when idle |

**Custom Model Unit (CMU):** A unit of compute allocated based on model size + context length.
- 7B model → ~1-2 CMUs
- 32B model → ~4-6 CMUs
- 72B model → ~8-12 CMUs

### Can We Custom Import a Model? — YES

**For ColdBones, the answer is yes.** Here's what to import:

| Question | Answer |
|---|---|
| Can we import Qwen3.5-35B-A3B? | **No** — Qwen 3.5 architecture not yet supported |
| Can we import Qwen2.5-VL-7B? | **Yes** — Qwen2_5_VL architecture is supported |
| Can we import quantized (AWQ/GPTQ)? | **No** — CMI requires FP16/BF16 full weights |
| Model format required? | Hugging Face safetensors |
| Max context length support? | Up to 128K (model-dependent) |
| Where to get weights? | `Qwen/Qwen2.5-VL-7B-Instruct` from Hugging Face (~15 GB) |

The `scripts/setup-bedrock-model.sh` script already handles the full pipeline:
download → S3 upload → create import job → poll → store ARN in SSM.

---

## 4. Bedrock CMI vs SageMaker Inference — Cost Comparison

### SageMaker Inference Options for a 7B VL Model

For Qwen2.5-VL-7B, you'd need a GPU instance with ≥16 GB VRAM:

| SageMaker Option | Instance | GPU | VRAM | $/hour | $/month (24/7) |
|---|---|---|---|---|---|
| **Real-Time Inference** | ml.g5.xlarge | 1x A10G | 24 GB | ~$1.41 | **$1,015** |
| **Real-Time Inference** | ml.g5.2xlarge | 1x A10G | 24 GB | ~$1.52 | **$1,094** |
| **Real-Time Inference** | ml.g6.xlarge | 1x L4 | 24 GB | ~$1.00 | **$720** |
| **Real-Time Inference** | ml.g6e.xlarge | 1x L40S | 48 GB | ~$1.86 | **$1,339** |
| **Async Inference** (scale to 0) | ml.g5.xlarge | 1x A10G | 24 GB | ~$1.41 | Varies |
| **Serverless Inference** | N/A | No GPU | — | — | **Not available for GPU** |

> **SageMaker Serverless Inference does NOT support GPU instances** — it's CPU-only.
> For LLM inference, you must use Real-Time or Asynchronous endpoints.

### Head-to-Head Comparison

#### Scenario A: Rare Fallback (desktop 99% uptime, ~4 hrs/month Bedrock)

| | Bedrock CMI (7B) | SageMaker Real-Time (ml.g5.xlarge) | SageMaker Async (ml.g5.xlarge) |
|---|---|---|---|
| **Monthly cost** | **~$42** | **$1,015** (24/7) | **~$6** (only when active) |
| **Scaling** | Auto, to zero | Must keep running or cold start ~5-10 min | Scale to 0, cold start ~5-10 min |
| **Cold start** | ~30-60s | ~5-10 min (model load) | ~5-10 min |
| **Setup complexity** | Low (import job) | High (container, endpoint config, model artifact) | High (same + async config) |
| **Infra to manage** | None | Endpoint, auto-scaling policies, container | Same + S3 I/O, SNS notifications |

#### Scenario B: Regular Usage (desktop 90% uptime, ~72 hrs/month)

| | Bedrock CMI (7B) | SageMaker Real-Time | SageMaker Async |
|---|---|---|---|
| **Monthly cost** | **~$695** | **$1,015** (24/7) | **~$101** (72 hrs active) |
| **Winner** | | | ✅ Cheapest |

#### Scenario C: Burst Usage (10 analyses/day when offline, ~5 hrs/month active)

| | Bedrock CMI (7B) | SageMaker Real-Time | SageMaker Async |
|---|---|---|---|
| **Monthly cost** | **~$244** (300 5-min windows) | **$1,015** (24/7) | **~$7** (5 hrs) |
| **Winner** | | | ✅ Cheapest |

#### Scenario D: Full Cloud-Only (no desktop, 24/7 inference)

| | Bedrock CMI (7B) | SageMaker Real-Time (ml.g5.xlarge) | SageMaker RT (ml.g6.xlarge) |
|---|---|---|---|
| **Monthly cost** | **~$5,652** (8640 windows) | **$1,015** | **$720** |
| **Winner** | | | ✅ Cheapest |

### When to Choose Each

| Use Case | Best Choice | Why |
|---|---|---|
| **Rare fallback (<10 hrs/mo)** | **Bedrock CMI** | Sub-minute cold start, zero infrastructure, scale to zero. SageMaker async is cheaper but 5-10 min cold starts are unacceptable for fallback UX |
| **Regular fallback (10-50 hrs/mo)** | **SageMaker Async** | Lower hourly cost, but only if you can tolerate 5-10 min cold starts |
| **Always-on cloud inference** | **SageMaker Real-Time** | Fixed hourly cost is far cheaper than Bedrock's per-window billing at 24/7 |
| **Lowest possible cost** | **SageMaker Async** | Can scale to 0, charged only while processing |
| **Fastest cold start** | **Bedrock CMI** | 30-60s vs 5-10 min for SageMaker |
| **Least operational burden** | **Bedrock CMI** | No container images, no endpoint configs, no auto-scaling policies |

### Recommendation for ColdBones

**Bedrock CMI is the right choice** because:
1. The desktop (RTX 5090) is the primary inference path — Bedrock is only a **fallback**
2. ~99% of requests go through the desktop — monthly Bedrock cost stays **<$50**
3. Sub-minute cold start means **instant failover** when the desktop goes offline
4. **Zero infrastructure** to manage — no Docker containers, no endpoint configs
5. The 5-minute billing windows are a good fit for sporadic fallback usage

SageMaker would only make sense if you plan to **run Bedrock 24/7** as the primary provider (which would cost >$5K/month on CMI vs ~$720/month on SageMaker ml.g6.xlarge).

---

## 5. Four-Way Cost Comparison — Bedrock CMI vs EC2 GPU vs SageMaker vs Qwen API

### The Options

| # | Option | What You Run | Billing Model |
|---|---|---|---|
| 1 | **Bedrock CMI** | Qwen2.5-VL-7B on Bedrock managed infra | Per 5-min active window (~$0.0785/min/CMU) |
| 2 | **EC2 Self-Hosted GPU** | Qwen model on a GPU EC2 instance you manage | Per hour (on-demand) or reserved |
| 3 | **SageMaker Inference** | Qwen on a managed ML endpoint | Per hour (real-time) or per-use (async) |
| 4 | **Qwen Official API** | Alibaba Cloud Model Studio (international endpoint, Singapore) | Per million tokens |

---

### EC2 GPU Instance Pricing (us-east-1, on-demand)

| Instance | GPU | VRAM | vCPUs | RAM | $/hour | $/month (24/7) | Can Run 7B? |
|---|---|---|---|---|---|---|---|
| g4dn.xlarge | 1× T4 | 16 GB | 4 | 16 GB | $0.526 | **$379** | ✅ Tight (INT8 quantized) |
| g5.xlarge | 1× A10G | 24 GB | 4 | 16 GB | $1.006 | **$724** | ✅ FP16 comfortably |
| g6.xlarge | 1× L4 | 24 GB | 4 | 16 GB | $0.6538 | **$471** | ✅ FP16 comfortably |
| g6e.xlarge | 1× L40S | 48 GB | 4 | 32 GB | $1.86 | **$1,339** | ✅ Room for 32B |

> **Add ~$10-20/month** for 100 GB gp3 EBS storage + data transfer.
> **Spot instances** can save 60-70% but may be interrupted at any time.
> **Reserved instances** (1-year, no upfront) save ~35%: g6.xlarge → ~$0.42/hr (~$306/mo).

#### EC2 Operational Overhead
- **You manage everything**: OS patching, CUDA driver updates, model serving (vLLM/TGI), health monitoring, restart on failure
- **No auto-scale to zero** — must stop/start instance programmatically (2-5 min boot time)
- **Security**: VPC, security groups, SSH key management
- **No built-in API Gateway integration** — need ALB or custom proxy

---

### Qwen Official API Pricing (Alibaba Cloud Model Studio)

Source: [alibabacloud.com/help/en/model-studio/models](https://www.alibabacloud.com/help/en/model-studio/models) — International deployment (Singapore endpoint, global compute excl. China Mainland).

#### Vision Models (for image analysis — our core use case)

| Model | Input $/M tokens | Output $/M tokens | Context | Notes |
|---|---|---|---|---|
| **qwen3-vl-plus** | $0.20 (≤32K) | $1.60 (≤32K) | 262K | Commercial, best quality, thinking support |
| **qwen3-vl-8b-instruct** | $0.18 | $0.70 | 131K | Open-source, closest to our Bedrock import |
| **qwen3-vl-30b-a3b-instruct** | $0.20 | $0.80 | 131K | Open-source MoE, non-thinking only |

#### Text Models (equivalent of our desktop model)

| Model | Input $/M tokens | Output $/M tokens | Context | Notes |
|---|---|---|---|---|
| **qwen3.5-35b-a3b** | $0.25 (≤256K) | $2.00 (≤256K) | 262K | Our exact desktop model |
| **qwen-flash** | $0.05 (≤256K) | $0.40 (≤256K) | 1M | Cheapest commercial model |
| **qwen-plus** (Qwen3.5) | $0.40 (≤256K) | $2.40 (≤256K) | 1M | Strongest general-purpose |

#### Key Considerations
- **Free tier**: 1M input + 1M output tokens, valid 90 days from account activation
- **Batch mode**: 50% discount on supported models
- **Endpoint**: Singapore (international) — latency from US will be **200-300ms+ RTT**
- **Data sovereignty**: Your data transits through Alibaba Cloud Singapore servers
- **Rate limits**: Per-model limits; contact Alibaba for higher quotas

---

### Per-Request Cost Comparison

A typical ColdBones image analysis request:
- **Input**: ~1,500 tokens (image encoding via VL tokenizer + text prompt)
- **Output**: ~500 tokens (structured analysis response)

| Option | Per-Request Cost | Notes |
|---|---|---|
| **Qwen API** (qwen3-vl-8b) | **$0.00062** | $0.00027 input + $0.00035 output |
| **Qwen API** (qwen3-vl-plus) | **$0.0011** | $0.0003 input + $0.0008 output |
| **EC2 GPU** (g6.xlarge, 24/7) | **$0** marginal | Paying $471/mo regardless — each extra request is free |
| **SageMaker RT** (ml.g6.xlarge) | **$0** marginal | Paying $720/mo regardless |
| **Bedrock CMI** (1.5 CMU) | **$0.59** minimum | Minimum 5-min billing window; free for subsequent requests in same window |

> **Bedrock CMI per-request cost is high** when each request triggers a new 5-min window.
> But if you batch multiple requests within one window, the effective per-request cost drops.

---

### Monthly Cost Comparison by Usage Pattern

#### Scenario 1: Rare Fallback (~4 hrs/month, ~50 requests)

*Desktop handles 99% of traffic. Cloud fallback only when desktop is offline.*

| Option | Monthly Cost | Cold Start | Ops Burden |
|---|---|---|---|
| **Bedrock CMI** | **~$42** | 30-60s | None |
| **Qwen API** (vl-8b) | **~$0.03** | None (always warm) | None |
| **Qwen API** (vl-plus) | **~$0.06** | None | None |
| **SageMaker Async** | **~$6** | 5-10 min | Medium |
| **SageMaker RT** (g6) | **$720** | None (always on) | Medium |
| **EC2 GPU** (g6, 24/7) | **$471** | None (always on) | High |
| **EC2 GPU** (g6, stop/start) | **~$3** | 2-5 min | High |

**Winner: Qwen API** — pennies per month, no cold start, no infrastructure.

#### Scenario 2: Moderate Fallback (~24 hrs/month, ~300 requests)

| Option | Monthly Cost | Cold Start | Ops Burden |
|---|---|---|---|
| **Bedrock CMI** | **~$245** | 30-60s | None |
| **Qwen API** (vl-8b) | **~$0.19** | None | None |
| **Qwen API** (vl-plus) | **~$0.33** | None | None |
| **SageMaker Async** | **~$34** | 5-10 min | Medium |
| **SageMaker RT** (g6) | **$720** | None | Medium |
| **EC2 GPU** (g6, 24/7) | **$471** | None | High |
| **EC2 GPU** (g6, on-demand start) | **~$16** | 2-5 min | High |

**Winner: Qwen API** — still under $1/month even at 300 requests.

#### Scenario 3: Heavy Cloud Usage (~200 hrs/month, ~3,000 requests)

| Option | Monthly Cost | Cold Start | Ops Burden |
|---|---|---|---|
| **Bedrock CMI** | **~$1,413** | 30-60s | None |
| **Qwen API** (vl-8b) | **~$1.86** | None | None |
| **Qwen API** (vl-plus) | **~$3.30** | None | None |
| **SageMaker Async** | **~$282** | 5-10 min | Medium |
| **SageMaker RT** (g6) | **$720** | None | Medium |
| **EC2 GPU** (g6, 24/7) | **$471** | None | High |

**Winner: Qwen API** — $1.86/month for 3,000 requests is absurdly cheap.

#### Scenario 4: Full Cloud-Only (24/7 primary, ~50,000 requests/month)

| Option | Monthly Cost | Cold Start | Ops Burden |
|---|---|---|---|
| **Bedrock CMI** | **~$5,652** | 30-60s | None |
| **Qwen API** (vl-8b) | **~$31** | None | None |
| **Qwen API** (vl-plus) | **~$55** | None | None |
| **SageMaker RT** (g6) | **$720** | None | Medium |
| **EC2 GPU** (g6, 24/7) | **$471** | None | High |
| **EC2 GPU** (g6, reserved 1yr) | **~$306** | None | High |

**Winner at low volume: Qwen API** ($31/mo for 50K requests).
**Winner at massive scale (>500K req/mo): EC2 Reserved** — fixed cost regardless of volume.

---

### Latency Comparison

| Option | First Request | Subsequent Requests | Infrastructure Location |
|---|---|---|---|
| **Desktop (RTX 5090)** | ~1-2s | ~1-2s | Local network via Tailscale |
| **Bedrock CMI** | 30-60s (cold) | 2-5s | us-east-1 (same region as app) |
| **EC2 GPU** (running) | 2-5s | 2-5s | us-east-1 |
| **EC2 GPU** (stopped) | 2-5 min (boot) | 2-5s | us-east-1 |
| **SageMaker RT** | 2-5s | 2-5s | us-east-1 |
| **SageMaker Async** | 5-10 min (cold) | 10-30s (async queue) | us-east-1 |
| **Qwen API** | 3-8s | 3-8s | Singapore (200-300ms RTT from US) |

---

### Decision Matrix

| Factor | Bedrock CMI | EC2 GPU | SageMaker | Qwen API |
|---|---|---|---|---|
| **Cost (low volume)** | ⚠️ Moderate | ❌ Expensive | ⚠️ Moderate | ✅ Cheapest |
| **Cost (high volume)** | ❌ Expensive | ✅ Cheapest | ⚠️ Moderate | ✅ Very cheap |
| **Cold start** | ✅ 30-60s | ⚠️ 2-5 min | ❌ 5-10 min | ✅ None |
| **Ops burden** | ✅ Zero | ❌ High | ⚠️ Medium | ✅ Zero |
| **Data sovereignty** | ✅ AWS us-east-1 | ✅ Your VPC | ✅ AWS us-east-1 | ⚠️ Alibaba SG |
| **Latency (from US)** | ✅ Low | ✅ Low | ✅ Low | ⚠️ 200-300ms RTT |
| **Model selection** | ⚠️ CMI-supported only | ✅ Any model | ✅ Any model | ✅ All Qwen models |
| **Reliability** | ✅ AWS SLA | ⚠️ Self-managed | ✅ AWS SLA | ⚠️ Alibaba SLA |
| **AWS integration** | ✅ Native | ⚠️ Manual | ✅ Native | ❌ External |

---

### Final Recommendation for ColdBones

**Keep Bedrock CMI as the fallback** despite the higher per-request cost:

1. **AWS-native integration** — already wired into API Gateway → Lambda → Bedrock pipeline
2. **Data stays in us-east-1** — no cross-cloud data transfer to Singapore
3. **Sub-minute cold start** — critical for seamless fallback UX
4. **Zero ops** — no instances to patch, no serving framework to maintain
5. **Monthly cost is acceptable** — at ~$42/month for rare fallback, it's the price of convenience

**Consider Qwen API as a future third provider** if:
- You want the absolute cheapest per-request cost ($0.0006/request)
- You're okay with routing data through Alibaba Cloud Singapore
- You want access to newer Qwen models (3.5, 3-VL) not yet in CMI
- You'd add it as another provider in the `ProviderContext` (alongside `local` and `cloud`)

**EC2 self-hosted only makes sense if**:
- You move to 24/7 cloud-primary deployment (no desktop)
- You need >100K requests/month at fixed cost
- You want maximum model flexibility (quantization, custom serving configs)

---

## 6. Architecture: Dual-Provider with Fallback

```
Frontend → API Gateway → analyze_router Lambda
                              │
                    ┌─────────┼─────────┐
                    ▼                   ▼
            Desktop alive?         Bedrock CMI
            (Tailscale)            (Qwen2.5-VL-7B)
                    │                   │
                    ▼                   ▼
          analyze_orchestrator   analyze_orchestrator
          (desktop_client.py)    (bedrock_client.py)
                    │                   │
                    ▼                   ▼
            LM Studio API        Bedrock Runtime API
            (RTX 5090)           (aws managed)
```

### Routing Logic

1. **User selects provider** (or "Auto"):
   - `local` → always try desktop, queue to SQS if offline
   - `cloud` → always use Bedrock
   - `auto` (default) → try desktop first, fall back to Bedrock instantly
2. **Health check**: `/api/health` returns status of both providers
3. **No SQS queue needed for Bedrock** — it's always available

---

## 7. S3 Model Bucket Setup

The model weights (~15 GB for 7B FP16) are stored in S3 and referenced by
the Bedrock import job.

```
s3://coldbones-models-{account-id}/
  └── qwen2.5-vl-7b-instruct/
      ├── config.json
      ├── generation_config.json
      ├── tokenizer_config.json
      ├── tokenizer.json
      ├── vocab.json
      ├── model.safetensors.index.json
      └── model-*.safetensors
```

---

## 8. Setup Steps

1. Run `scripts/setup-bedrock-model.sh` to download model and upload to S3
2. The script creates the Bedrock import job automatically
3. Deploy updated infrastructure: `bash scripts/deploy.sh api`
4. Model ARN is stored in SSM at `/coldbones/bedrock-model-arn`
