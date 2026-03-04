import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface ModelLaunchTemplateProps {
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  instanceRole: iam.IRole;
  /** GPU instance type — g5.2xlarge by default */
  instanceType?: ec2.InstanceType;
  modelQuant?: string;
  /** Name of an existing SSM param that stores the OpenAI API key */
  openaiKeyParam?: string;
  /** S3 bucket name where model weights live */
  modelBucket?: string;
  dataVolumeSizeGib?: number;
}

export class ModelLaunchTemplate extends Construct {
  public readonly launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: ModelLaunchTemplateProps) {
    super(scope, id);

    const instanceType =
      props.instanceType ?? new ec2.InstanceType('g5.2xlarge');
    const quant = props.modelQuant ?? 'Q4_K_M';
    const modelBucket = props.modelBucket ?? '';

    // Deep Learning AMI (GPU) with CUDA 12.x — resolved at synth time via SSM
    const ami = ec2.MachineImage.latestAmazonLinux2({
      cachedInContext: true,
    });

    // User-data script
    const udScript = this.buildUserData(quant, modelBucket, props.openaiKeyParam);
    const userData = ec2.UserData.forLinux();
    userData.addCommands(...udScript);

    // EBS root: OS volume
    const rootVolume: ec2.BlockDevice = {
      deviceName: '/dev/xvda',
      volume: ec2.BlockDeviceVolume.ebs(200, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        deleteOnTermination: true,
        encrypted: true,
      }),
    };

    // EBS data: model weights
    const dataVolume: ec2.BlockDevice = {
      deviceName: '/dev/xvdb',
      volume: ec2.BlockDeviceVolume.ebs(props.dataVolumeSizeGib ?? 100, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        iops: 6000,
        throughput: 500,
        deleteOnTermination: false,
        encrypted: true,
      }),
    };

    this.launchTemplate = new ec2.LaunchTemplate(this, 'LT', {
      instanceType,
      machineImage: ami,
      userData,
      role: props.instanceRole,
      securityGroup: props.securityGroup,
      blockDevices: [rootVolume, dataVolume],
      requireImdsv2: true,
      detailedMonitoring: true,
    });

    cdk.Tags.of(this.launchTemplate).add('Component', 'ModelServer');
  }

  private buildUserData(
    quant: string,
    modelBucket: string,
    openaiKeyParam?: string,
  ): string[] {
    const fetchKey = openaiKeyParam
      ? `export OPENAI_API_KEY=$(aws ssm get-parameter --name '${openaiKeyParam}' --with-decryption --query 'Parameter.Value' --output text)`
      : '# no openai key param configured';

    return [
      '#!/bin/bash',
      'set -euo pipefail',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      '',
      '# --- mount data volume ---',
      'DEVICE=/dev/xvdb',
      'MOUNT=/data',
      'if ! blkid "$DEVICE"; then mkfs.ext4 -L modeldata "$DEVICE"; fi',
      'mkdir -p "$MOUNT"',
      'echo "LABEL=modeldata $MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab',
      'mount -a',
      '',
      '# --- install dependencies ---',
      'yum install -y git cmake ninja-build python3-pip wget curl',
      'pip3 install --upgrade pip',
      '',
      '# --- CUDA / drivers (Deep Learning AMI already has these) ---',
      'export PATH=/usr/local/cuda/bin:$PATH',
      'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH',
      '',
      '# --- build llama.cpp with CUDA ---',
      'if [ ! -f /data/llama.cpp/.built ]; then',
      '  git clone https://github.com/ggerganov/llama.cpp /data/llama.cpp',
      '  cd /data/llama.cpp',
      '  cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -G Ninja',
      '  cmake --build build --config Release',
      '  touch .built',
      'fi',
      '',
      '# --- download model weights ---',
      `MODEL_DIR=/data/models`,
      `QUANT="${quant}"`,
      'mkdir -p "$MODEL_DIR"',
      modelBucket
        ? `aws s3 sync s3://${modelBucket}/models/ "$MODEL_DIR/" --exclude "*" --include "*.gguf" --no-progress`
        : '# model bucket not configured — place .gguf in /data/models manually',
      '',
      '# --- fetch API key from SSM ---',
      fetchKey,
      '',
      '# --- write systemd service ---',
      'GGUF=$(ls $MODEL_DIR/*.gguf 2>/dev/null | head -n1)',
      'cat > /etc/systemd/system/llama-server.service <<EOF',
      '[Unit]',
      'Description=llama.cpp HTTP server',
      'After=network.target',
      '',
      '[Service]',
      'ExecStart=/data/llama.cpp/build/bin/llama-server \\',
      '  --model $GGUF \\',
      '  --host 0.0.0.0 --port 8080 \\',
      '  --n-gpu-layers 999 \\',
      '  --ctx-size 32768 \\',
      '  --threads 8 \\',
      '  --parallel 2',
      'Restart=on-failure',
      'RestartSec=10',
      'StandardOutput=journal',
      'StandardError=journal',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      '',
      'systemctl daemon-reload',
      'systemctl enable --now llama-server',
      '',
      '# --- signal CloudFormation ---',
      '/opt/aws/bin/cfn-signal -e $? --region "$AWS_DEFAULT_REGION" || true',
    ];
  }
}
