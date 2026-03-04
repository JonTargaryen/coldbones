#!/usr/bin/env bash
# =============================================================================
# setup-model-server.sh
# EC2 user-data / manual setup script for Coldbones GPU model server.
# Installs llama.cpp with CUDA support, downloads model weights from S3,
# and configures a systemd service that starts on boot.
#
# Usage (manual):
#   sudo bash setup-model-server.sh [--model-bucket BUCKET] [--quant Q4_K_M]
#
# Environment variables (can also be passed as args):
#   MODEL_BUCKET   S3 bucket containing .gguf model files
#   MODEL_QUANT    Quantization suffix to prefer (default: Q4_K_M)
#   LLAMA_PORT     Port the server listens on (default: 8080)
#   GPU_LAYERS     Number of layers to offload to GPU (default: 999 = all)
#   CTX_SIZE       Context window size (default: 32768)
#   PARALLEL       Parallel inference slots (default: 2)
# =============================================================================
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
MODEL_BUCKET="${MODEL_BUCKET:-}"
MODEL_QUANT="${MODEL_QUANT:-Q4_K_M}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
GPU_LAYERS="${GPU_LAYERS:-999}"
CTX_SIZE="${CTX_SIZE:-32768}"
PARALLEL="${PARALLEL:-2}"
DATA_MOUNT="/data"
LLAMA_DIR="${DATA_MOUNT}/llama.cpp"
MODEL_DIR="${DATA_MOUNT}/models"
LOG_FILE="/var/log/coldbones-setup.log"

# ── CLI argument parsing ──────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model-bucket) MODEL_BUCKET="$2"; shift 2 ;;
    --quant)        MODEL_QUANT="$2";  shift 2 ;;
    --port)         LLAMA_PORT="$2";   shift 2 ;;
    --ctx-size)     CTX_SIZE="$2";     shift 2 ;;
    --parallel)     PARALLEL="$2";     shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

exec > >(tee -a "$LOG_FILE" | logger -t coldbones-setup -s 2>/dev/console) 2>&1
echo "=== Coldbones model server setup started at $(date) ==="

# ── Mount data volume ─────────────────────────────────────────────────────────
DEVICE=/dev/xvdb
if lsblk "$DEVICE" &>/dev/null; then
  if ! blkid "$DEVICE" | grep -q ext4; then
    echo "Formatting data volume..."
    mkfs.ext4 -L modeldata "$DEVICE"
  fi
  mkdir -p "$DATA_MOUNT"
  if ! mountpoint -q "$DATA_MOUNT"; then
    mount "$DEVICE" "$DATA_MOUNT"
  fi
  # Persist in fstab
  if ! grep -q modeldata /etc/fstab; then
    echo "LABEL=modeldata $DATA_MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab
  fi
else
  echo "WARNING: /dev/xvdb not found — using root volume"
  mkdir -p "$DATA_MOUNT"
fi

mkdir -p "$MODEL_DIR"

# ── System dependencies ───────────────────────────────────────────────────────
echo "Installing system packages..."
if command -v dnf &>/dev/null; then
  dnf install -y git cmake ninja-build python3-pip gcc g++ wget curl awscli
elif command -v yum &>/dev/null; then
  yum install -y git cmake ninja-build python3-pip gcc gcc-c++ wget curl awscli
elif command -v apt-get &>/dev/null; then
  apt-get update -q && apt-get install -y git cmake ninja-build python3-pip gcc g++ wget curl awscli
fi

# ── CUDA environment ──────────────────────────────────────────────────────────
export PATH="/usr/local/cuda/bin:$PATH"
export LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}"

if ! command -v nvcc &>/dev/null; then
  echo "WARNING: nvcc not found — GPU acceleration may be unavailable"
fi

# ── Build llama.cpp ───────────────────────────────────────────────────────────
if [[ -f "${LLAMA_DIR}/.built" ]]; then
  echo "llama.cpp already built — skipping"
else
  echo "Cloning llama.cpp..."
  git clone --depth=1 https://github.com/ggerganov/llama.cpp "$LLAMA_DIR"
  cd "$LLAMA_DIR"

  echo "Building llama.cpp with CUDA support..."
  CMAKE_ARGS="-DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release"
  if ! command -v nvcc &>/dev/null; then
    echo "Building without CUDA (CPU only)..."
    CMAKE_ARGS="-DCMAKE_BUILD_TYPE=Release"
  fi

  cmake -B build $CMAKE_ARGS -G Ninja
  cmake --build build --config Release --parallel "$(nproc)"
  touch .built
  echo "llama.cpp build complete"
  cd - >/dev/null
fi

# ── Download model weights ────────────────────────────────────────────────────
GGUF_FILE=$(find "$MODEL_DIR" -name "*${MODEL_QUANT}*.gguf" | head -n1)

if [[ -z "$GGUF_FILE" ]]; then
  if [[ -n "$MODEL_BUCKET" ]]; then
    echo "Syncing model weights from s3://${MODEL_BUCKET}/models/..."
    aws s3 sync "s3://${MODEL_BUCKET}/models/" "$MODEL_DIR/" \
      --exclude "*" --include "*.gguf" --no-progress
    GGUF_FILE=$(find "$MODEL_DIR" -name "*${MODEL_QUANT}*.gguf" | head -n1)
  fi

  if [[ -z "$GGUF_FILE" ]]; then
    echo "WARNING: No .gguf file found in ${MODEL_DIR}."
    echo "Place your model at ${MODEL_DIR}/<model>.gguf and restart llama-server."
    GGUF_FILE="${MODEL_DIR}/model.gguf"  # placeholder — will fail if missing
  fi
fi

echo "Using model: $GGUF_FILE"

# ── Write systemd service ─────────────────────────────────────────────────────
LLAMA_BIN="${LLAMA_DIR}/build/bin/llama-server"

cat > /etc/systemd/system/llama-server.service <<SERVICE
[Unit]
Description=llama.cpp HTTP inference server
Documentation=https://github.com/ggerganov/llama.cpp
After=network.target

[Service]
Type=simple
User=root
ExecStart=${LLAMA_BIN} \\
  --model ${GGUF_FILE} \\
  --host 0.0.0.0 \\
  --port ${LLAMA_PORT} \\
  --n-gpu-layers ${GPU_LAYERS} \\
  --ctx-size ${CTX_SIZE} \\
  --threads $(nproc) \\
  --parallel ${PARALLEL} \\
  --log-format json \\
  --metrics
Restart=on-failure
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llama-server

# Limit to avoid OOM
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable llama-server
systemctl restart llama-server

# ── Health check ──────────────────────────────────────────────────────────────
echo "Waiting for llama-server to start..."
HEALTH_URL="http://127.0.0.1:${LLAMA_PORT}/health"
for i in $(seq 1 30); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "llama-server is healthy after ${i}x5s"
    break
  fi
  sleep 5
done

if ! curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
  echo "ERROR: llama-server failed health check — check journalctl -u llama-server"
  exit 1
fi

# ── CloudWatch agent config ───────────────────────────────────────────────────
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<CWA
{
  "agent": { "metrics_collection_interval": 60 },
  "metrics": {
    "append_dimensions": {
      "AutoScalingGroupName": "\${aws:AutoScalingGroupName}",
      "InstanceId": "\${aws:InstanceId}"
    },
    "metrics_collected": {
      "cpu": { "measurement": ["cpu_usage_idle", "cpu_usage_user"], "metrics_collection_interval": 60 },
      "mem": { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["disk_used_percent"], "resources": ["${DATA_MOUNT}"] },
      "nvidia_gpu": {
        "measurement": ["utilization_gpu", "utilization_memory", "temperature_gpu"],
        "metrics_collection_interval": 30
      }
    }
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "${LOG_FILE}",
            "log_group_name": "/coldbones/model-server",
            "log_stream_name": "{instance_id}/setup.log"
          }
        ]
      }
    }
  }
}
CWA

if command -v /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl &>/dev/null; then
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config -m ec2 \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json \
    -s
fi

echo "=== Coldbones model server setup complete at $(date) ==="
