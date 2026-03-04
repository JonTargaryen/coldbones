#!/usr/bin/env bash
# =============================================================================
# build-ami.sh
# Builds a custom GPU AMI for Coldbones model servers using Packer.
# The AMI comes pre-baked with:
#   - llama.cpp compiled with CUDA
#   - CloudWatch agent
#   - Spot interruption handler systemd service
#   - All system dependencies
#
# Pre-requisites:
#   - Packer ≥ 1.10  (brew install hashicorp/tap/packer  OR  https://packer.io)
#   - AWS credentials with EC2/IAM permissions
#   - jq
#
# Usage:
#   ./scripts/build-ami.sh [--region us-east-1] [--instance-type g5.2xlarge]
# =============================================================================
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
AWS_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
INSTANCE_TYPE="${PACKER_INSTANCE_TYPE:-g5.2xlarge}"
AMI_NAME="coldbones-gpu-$(date +%Y%m%d-%H%M)"
PACKER_DIR="$(dirname "$0")/../packer"
PACKER_FILE="${PACKER_DIR}/coldbones-gpu.pkr.hcl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)        AWS_REGION="$2";       shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2";    shift 2 ;;
    --ami-name)      AMI_NAME="$2";         shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Check packer ──────────────────────────────────────────────────────────────
if ! command -v packer &>/dev/null; then
  echo "ERROR: packer not found. Install from https://packer.io/downloads"
  exit 1
fi

# ── Create packer template if it doesn't exist ─────────────────────────────── 
mkdir -p "$PACKER_DIR"
cat > "$PACKER_FILE" <<'PACKER'
packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region"        { type = string }
variable "instance_type" { type = string }
variable "ami_name"      { type = string }

data "amazon-ami" "dlami" {
  region = var.region
  owners = ["amazon"]
  filters = {
    name                = "Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2) *"
    root-device-type    = "ebs"
    virtualization-type = "hvm"
    state               = "available"
  }
  most_recent = true
}

source "amazon-ebs" "coldbones" {
  region              = var.region
  source_ami          = data.amazon-ami.dlami.id
  instance_type       = var.instance_type
  ssh_username        = "ec2-user"
  ami_name            = var.ami_name
  ami_description     = "Coldbones GPU AMI with llama.cpp pre-built"

  tags = {
    Name      = var.ami_name
    Project   = "Coldbones"
    BuildDate = timestamp()
  }

  # Only store AMI in the one region
  ami_regions = [var.region]

  # Root volume
  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 200
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  # Subnet / VPC from default VPC
  associate_public_ip_address = true
}

build {
  sources = ["source.amazon-ebs.coldbones"]

  provisioner "shell" {
    inline = [
      "set -euo pipefail",
      "export PATH=/usr/local/cuda/bin:$PATH",
      "export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH",
      "echo 'Updating packages...'",
      "sudo yum update -y -q",
      "sudo yum install -y git cmake ninja-build python3-pip gcc gcc-c++ wget curl",
      "echo 'Building llama.cpp...'",
      "sudo mkdir -p /data/llama.cpp",
      "sudo git clone --depth=1 https://github.com/ggerganov/llama.cpp /data/llama.cpp",
      "cd /data/llama.cpp && sudo cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -G Ninja",
      "cd /data/llama.cpp && sudo cmake --build build --config Release --parallel $(nproc)",
      "sudo touch /data/llama.cpp/.built",
      "echo 'llama.cpp build complete'",
    ]
  }

  provisioner "file" {
    source      = "scripts/spot-interrupt-handler.sh"
    destination = "/tmp/spot-interrupt-handler.sh"
  }

  provisioner "shell" {
    inline = [
      "sudo install -m 755 /tmp/spot-interrupt-handler.sh /usr/local/bin/spot-interrupt-handler",
      "sudo tee /etc/systemd/system/spot-interrupt-handler.service > /dev/null << 'SVC'",
      "[Unit]",
      "Description=Coldbones Spot Interrupt Handler",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      "ExecStart=/usr/local/bin/spot-interrupt-handler",
      "Restart=always",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "SVC",
      "sudo systemctl daemon-reload",
      "sudo systemctl enable spot-interrupt-handler",
    ]
  }
}
PACKER

echo "Packer template written to: ${PACKER_FILE}"
echo "Building AMI: ${AMI_NAME} in ${AWS_REGION} using ${INSTANCE_TYPE}..."

packer init "$PACKER_FILE"

packer build \
  -var "region=${AWS_REGION}" \
  -var "instance_type=${INSTANCE_TYPE}" \
  -var "ami_name=${AMI_NAME}" \
  "$PACKER_FILE"

echo ""
echo "AMI build complete!"

# ── Store AMI ID in SSM ───────────────────────────────────────────────────────
AMI_ID=$(
  aws ec2 describe-images \
    --region "$AWS_REGION" \
    --owners self \
    --filters "Name=name,Values=${AMI_NAME}" \
    --query "Images[0].ImageId" \
    --output text
)

echo "AMI ID: ${AMI_ID}"

aws ssm put-parameter \
  --name "/coldbones/gpu-ami-id" \
  --value "$AMI_ID" \
  --type String \
  --overwrite \
  --region "$AWS_REGION"

echo "AMI ID stored in SSM: /coldbones/gpu-ami-id = ${AMI_ID}"
