# Desktop Worker Setup

Two pieces are needed:
1. **Tailscale Funnel** — exposes your local vLLM to AWS Lambdas (HTTPS, no open router ports)
2. **Worker process** — long-polls SQS and runs inference locally

---

## 1. Tailscale

Install and authenticate Tailscale on the desktop, then enable Funnel for port 8000:

```bash
# Install (Ubuntu/Debian)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Expose vLLM publicly via Tailscale Funnel (HTTPS → localhost:8000)
sudo tailscale funnel 8000
```

Your public Funnel URL will be something like:
```
https://seratonin.tail40ae2c.ts.net
```

Check it with:
```bash
tailscale funnel status
```

---

## 2. vLLM

```bash
pip install vllm

# Serve the model (adjust --tensor-parallel-size for your GPU count)
vllm serve Qwen/Qwen3.5-35B-A3B-AWQ \
  --api-key coldbones \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len 8192 \
  --tensor-parallel-size 1
```

Verify: `curl http://localhost:8000/health` should return `{"status":"ok"}`.

---

## 3. AWS SSM Parameters

Set these two parameters so the Lambdas can discover the desktop endpoint:

```bash
# Replace with your actual Tailscale Funnel hostname
TAILSCALE_URL="https://seratonin.tail40ae2c.ts.net"

aws ssm put-parameter \
  --name "/coldbones/desktop-url" \
  --value "$TAILSCALE_URL" \
  --type String \
  --overwrite

aws ssm put-parameter \
  --name "/coldbones/desktop-port" \
  --value "8000" \
  --type String \
  --overwrite
```

---

## 4. IAM Credentials for the Worker

Create a scoped IAM user (or use an instance profile / role):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SQS",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:*:*:ColdbonesAnalysisQueue*"
    },
    {
      "Sid": "S3",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::coldbones-uploads-*/*"
    },
    {
      "Sid": "DynamoDB",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:*:*:table/ColdbonesJobs*"
    }
  ]
}
```

---

## 5. Worker Installation

```bash
# Clone / pull the repo on the desktop, then:
cd /path/to/coldbones/worker

# Create a virtualenv
python3 -m venv /opt/coldbones/venv
/opt/coldbones/venv/bin/pip install -r requirements.txt

# Install poppler (needed by pdf2image)
# Ubuntu/Debian:
sudo apt install -y poppler-utils
# Windows:
#   choco install poppler

# Copy and fill in the env file
cp .env.example .env
nano .env   # fill in AWS creds, queue URL, bucket, table

# Test run
/opt/coldbones/venv/bin/python worker.py
```

---

## 6. Run as a systemd Service (Linux)

```bash
# Copy the service file
sudo cp coldbones-worker@.service /etc/systemd/system/

# Enable and start (replace <your-username> with your OS user)
sudo systemctl daemon-reload
sudo systemctl enable coldbones-worker@<your-username>
sudo systemctl start  coldbones-worker@<your-username>

# Check status
sudo systemctl status coldbones-worker@<your-username>
journalctl -u coldbones-worker@<your-username> -f
```

The service auto-restarts on failure and starts on boot.

---

## Verify End-to-End

1. Desktop: `tailscale funnel status` → Funnel URL shown
2. Desktop: `curl http://localhost:8000/health` → `{"status":"ok"}`
3. Mac: `curl https://<your-funnel-url>/health` → `{"status":"ok"}`
4. AWS: `aws ssm get-parameter --name /coldbones/desktop-url` → your Funnel URL
5. Upload a photo via the web app with mode=fast
6. If desktop is on → result in a few seconds
7. If desktop is off → status shows QUEUED; turn desktop on → worker picks it up

---

## Windows notes

If the desktop runs Windows:
- Run the worker in WSL2 (Ubuntu) — Tailscale + vLLM both work there
- Or use Task Scheduler / NSSM instead of systemd for the service
- Tailscale Funnel works identically on Windows: `tailscale funnel 8000`
