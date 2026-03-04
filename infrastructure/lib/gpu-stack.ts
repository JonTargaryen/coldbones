/**
 * ColdbonesGpu — cloud GPU stack
 *
 * Runs Qwen/Qwen3.5-35B-A3B-AWQ on a spot g6e.2xlarge (L40S 48 GB VRAM)
 * via vLLM, exposed on port 8000 inside the VPC.
 *
 * Persistence strategy:
 *   - A named 250 GB GP3 EBS volume is created in a fixed AZ and tagged
 *     "ColdbonesModelData".  The ASG is pinned to that same AZ so the volume
 *     can be re-attached on every boot without re-downloading the 25 GB model.
 *   - On first boot the user-data script formats the volume and pulls the model
 *     weights from HuggingFace.  On subsequent boots it just mounts and starts
 *     vLLM in < 60 s.
 *
 * Access:
 *   The GPU private IP is written to SSM Parameter Store (/coldbones/gpu-ip)
 *   by the lifecycle_manager Lambda once the vLLM health check passes.
 *   Lambdas read that parameter at invocation time.
 *
 * Cost controls:
 *   - Spot ASG (min=0, desired=0) — only running when there is work.
 *   - CloudWatch idle alarm auto-scales to 0 after N minutes of no inference.
 *   - EventBridge overnight shutdown / morning warmup via schedule_manager.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface GpuStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  gpuSecurityGroup: ec2.ISecurityGroup;
  notificationTopic: sns.ITopic;
  uploadBucket: s3.IBucket;          // for saving results alongside uploads

  model?: string;                         // HF model id
  vllmPort?: number;
  maxModelLen?: number;
  instanceTypes?: string[];               // preference order for mixed fleet
  useSpot?: boolean;
  spotMaxPrice?: string;
  dataVolumeGib?: number;

  // Scheduling
  idleShutdownMinutes?: number;
  overnightShutdownHour?: number;         // UTC hour
  morningWarmupHour?: number;             // UTC hour
  enableWeekendShutdown?: boolean;
}

export class GpuStack extends cdk.Stack {
  /** Name of the single GPU ASG. */
  public readonly asgName: string;
  /** SSM parameter that holds the current GPU private IP. */
  public readonly gpuIpParamName = '/coldbones/gpu-ip';
  /** SSM parameter that holds the vLLM port. */
  public readonly gpuPortParamName = '/coldbones/gpu-port';
  /** ASG name SSM param (used by schedule_manager). */
  public readonly asgNameParamName = '/coldbones/gpu-asg-name';

  constructor(scope: Construct, id: string, props: GpuStackProps) {
    super(scope, id, props);

    const {
      model = 'Qwen/Qwen3.5-35B-A3B-AWQ',
      vllmPort = 8000,
      maxModelLen = 16384,
      instanceTypes = ['g6e.2xlarge', 'g5.12xlarge', 'p3.8xlarge'],
      useSpot = true,
      spotMaxPrice = '2.50',
      dataVolumeGib = 250,
      idleShutdownMinutes = 30,
      overnightShutdownHour = 23,
      morningWarmupHour = 7,
      enableWeekendShutdown = true,
    } = props;

    // Pin to the first private subnet's AZ for EBS affinity
    const privateSubnets = props.vpc.privateSubnets;
    const pinnedAz = privateSubnets[0].availabilityZone;
    const pinnedSubnet = privateSubnets[0];

    // ─── Persistent model EBS volume ──────────────────────────────────────
    // deleteOnTermination=false means the volume outlives instance replacements.
    // We identify it by the "ColdbonesModelData" tag; user-data re-attaches it.
    const modelVolume = new ec2.CfnVolume(this, 'ModelVolume', {
      availabilityZone: pinnedAz,
      size: dataVolumeGib,
      volumeType: 'gp3',
      iops: 6000,
      throughput: 500,
      encrypted: true,
      tags: [
        { key: 'Name', value: 'ColdbonesModelData' },
        { key: 'Project', value: 'Coldbones' },
        { key: 'Description', value: `${model} weights — DO NOT DELETE` },
      ],
    });
    modelVolume.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const volumeId = modelVolume.ref;  // volume ID at deploy time

    // ─── IAM instance role ────────────────────────────────────────────────
    const instanceRole = new iam.Role(this, 'GpuInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // Allow the instance to describe/attach the model volume
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:AttachVolume', 'ec2:DescribeVolumes', 'ec2:DetachVolume'],
      resources: ['*'],
    }));

    // Allow writing GPU IP to SSM
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/coldbones/*`,
      ],
    }));

    // Allow lifecycle hook completion
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:CompleteLifecycleAction',
        'autoscaling:RecordLifecycleActionHeartbeat',
      ],
      resources: ['*'],
    }));

    // Allow reading from the upload bucket (for lifecycle health check pass-through)
    props.uploadBucket.grantRead(instanceRole);

    // Allow CloudFormation signal
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:SignalResource'],
      resources: ['*'],
    }));

    // ─── Deep Learning AMI ────────────────────────────────────────────────
    // Ubuntu 22.04 with CUDA 12.x — supports vLLM natively.
    // Resolves to the latest DL AMI at synth time.
    const ami = ec2.MachineImage.fromSsmParameter(
      '/aws/service/deeplearning/ami/x86_64/ubuntu-22.04-ecs-optimized-gpu/latest/image_id',
      { os: ec2.OperatingSystemType.LINUX },
    );

    // ─── User data ────────────────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'exec > >(tee /var/log/coldbones-startup.log | logger -t coldbones -s 2>/dev/console) 2>&1',
      'set -euo pipefail',
      '',
      '# ── System packages ─────────────────────────────────────────────────',
      'apt-get update -qq',
      'apt-get install -y -qq awscli python3-pip nvme-cli jq poppler-utils',
      '',
      '# ── Install / upgrade vLLM ──────────────────────────────────────────',
      'pip3 install --upgrade "vllm>=0.4.0" huggingface_hub transformers accelerate --quiet',
      '',
      `# ── Store config in SSM ─────────────────────────────────────────────`,
      `REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)`,
      `INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)`,
      `PRIVATE_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)`,
      `aws ssm put-parameter --region "$REGION" --name '${this.gpuIpParamName}' \\`,
      `  --value "$PRIVATE_IP" --type String --overwrite`,
      `aws ssm put-parameter --region "$REGION" --name '${this.gpuPortParamName}' \\`,
      `  --value '${vllmPort}' --type String --overwrite`,
      '',
      '# ── Attach / mount persistent model volume ───────────────────────────',
      `VOLUME_ID="${volumeId}"`,
      'DEVICE=/dev/nvme1n1',
      'MOUNT=/data',
      '',
      '# Wait for volume to be available and attached',
      'for i in $(seq 1 30); do',
      '  VOL_STATE=$(aws ec2 describe-volumes --region "$REGION" --volume-ids "$VOLUME_ID" \\',
      '    --query "Volumes[0].State" --output text 2>/dev/null || echo "unknown")',
      '  if [ "$VOL_STATE" = "available" ]; then',
      '    aws ec2 attach-volume --region "$REGION" --volume-id "$VOLUME_ID" \\',
      '      --instance-id "$INSTANCE_ID" --device /dev/xvdb || true',
      '    break',
      '  elif [ "$VOL_STATE" = "in-use" ]; then',
      '    break  # already attached (e.g. same instance restarted)',
      '  fi',
      '  echo "Waiting for volume $VOLUME_ID (state=$VOL_STATE)…"',
      '  sleep 10',
      'done',
      '',
      '# Wait for device node',
      'for i in $(seq 1 30); do',
      '  if [ -b "$DEVICE" ]; then break; fi',
      '  # NVMe enumeration might use different suffix',
      '  DEVICE=$(lsblk -dpno NAME | grep -E "nvme[0-9]+n[0-9]+" | tail -1 || echo "")',
      '  [ -n "$DEVICE" ] && break',
      '  sleep 5',
      'done',
      '',
      '# Format only if blank (first boot)',
      'if ! blkid "$DEVICE" 2>/dev/null; then',
      '  echo "First boot — formatting $DEVICE"',
      '  mkfs.ext4 -L coldbonesdata "$DEVICE"',
      'fi',
      '',
      'mkdir -p "$MOUNT"',
      'mount -o defaults,noatime "$DEVICE" "$MOUNT" || mount -L coldbonesdata "$MOUNT"',
      'echo "$(blkid -s UUID -o value $DEVICE) $MOUNT ext4 defaults,noatime 0 2" >> /etc/fstab || true',
      '',
      '# ── Download model (idempotent) ──────────────────────────────────────',
      `MODEL="${model}"`,
      'MODEL_DIR="$MOUNT/models/$(echo $MODEL | tr / -)"',
      'mkdir -p "$MODEL_DIR"',
      '',
      'if [ ! -f "$MODEL_DIR/.download_complete" ]; then',
      '  echo "Downloading $MODEL from HuggingFace…"',
      `  python3 -c "`,
      `from huggingface_hub import snapshot_download`,
      `snapshot_download('$MODEL', local_dir='$MODEL_DIR', local_dir_use_symlinks=False,`,
      `  ignore_patterns=['*.md', '*.txt', 'original/*'])`,
      `"`,
      '  touch "$MODEL_DIR/.download_complete"',
      '  echo "Model download complete."',
      'else',
      '  echo "Model already on disk — skipping download."',
      'fi',
      '',
      '# ── Write vLLM systemd service ───────────────────────────────────────',
      'cat > /etc/systemd/system/vllm.service <<SVCEOF',
      '[Unit]',
      'Description=vLLM inference server',
      'After=network.target',
      'Wants=network.target',
      '',
      '[Service]',
      'Type=simple',
      'Environment=HF_HOME=/data/hf_cache',
      `Environment=MODEL_DIR=$MODEL_DIR`,
      'ExecStart=/usr/local/bin/python3 -m vllm.entrypoints.openai.api_server \\',
      `  --model $MODEL_DIR \\`,
      `  --served-model-name ${model} \\`,
      `  --host 0.0.0.0 --port ${vllmPort} \\`,
      `  --max-model-len ${maxModelLen} \\`,
      '  --max-num-seqs 8 \\',
      '  --gpu-memory-utilization 0.92 \\',
      '  --dtype auto \\',
      '  --trust-remote-code \\',
      '  --disable-log-requests',
      'Restart=on-failure',
      'RestartSec=15',
      'StandardOutput=journal',
      'StandardError=journal',
      'LimitNOFILE=65536',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SVCEOF',
      '',
      'systemctl daemon-reload',
      'systemctl enable --now vllm',
      '',
      '# ── Wait for vLLM health (lifecycle hook heartbeat) ──────────────────',
      `PORT=${vllmPort}`,
      'echo "Waiting for vLLM to become ready on port $PORT…"',
      'for i in $(seq 1 120); do',
      '  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null || echo 0)',
      '  if [ "$HTTP" = "200" ]; then',
      '    echo "vLLM is ready (attempt $i)"',
      '    break',
      '  fi',
      '  sleep 10',
      'done',
      '',
      '# ── Complete lifecycle hook ───────────────────────────────────────────',
      'HOOK_NAME=$(aws autoscaling describe-auto-scaling-instances --region "$REGION" \\',
      '  --instance-ids "$INSTANCE_ID" \\',
      '  --query "AutoScalingInstances[0].AutoScalingGroupName" --output text 2>/dev/null || echo "")',
      '',
      'if [ -n "$HOOK_NAME" ]; then',
      '  TOKEN=$(aws autoscaling describe-lifecycle-hooks --region "$REGION" \\',
      '    --auto-scaling-group-name "$HOOK_NAME" \\',
      '    --query "LifecycleHooks[0].LifecycleHookName" \\',
      '    --output text 2>/dev/null || echo "")',
      '  if [ -n "$TOKEN" ]; then',
      '    aws autoscaling complete-lifecycle-action --region "$REGION" \\',
      '      --auto-scaling-group-name "$HOOK_NAME" \\',
      '      --lifecycle-hook-name "$TOKEN" \\',
      '      --instance-id "$INSTANCE_ID" \\',
      '      --lifecycle-action-result CONTINUE || true',
      '    echo "Lifecycle CONTINUE sent."',
      '  fi',
      'fi',
      '',
      'echo "GPU instance startup complete."',
    );

    // ─── Launch Template ──────────────────────────────────────────────────
    const primaryType = instanceTypes[0];

    const launchTemplate = new ec2.LaunchTemplate(this, 'GpuLaunchTemplate', {
      instanceType: new ec2.InstanceType(primaryType),
      machineImage: ami,
      userData,
      role: instanceRole,
      securityGroup: props.gpuSecurityGroup,
      requireImdsv2: true,
      detailedMonitoring: true,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
            encrypted: true,
          }),
        },
      ],
    });

    // ─── Spot ASG ─────────────────────────────────────────────────────────
    const overrides: autoscaling.LaunchTemplateOverrides[] = instanceTypes.map(t => ({
      instanceType: new ec2.InstanceType(t),
      launchTemplate,
    }));

    const asg = new autoscaling.AutoScalingGroup(this, 'GpuAsg', {
      vpc: props.vpc,
      vpcSubnets: { subnets: [pinnedSubnet] },
      mixedInstancesPolicy: {
        launchTemplate,
        launchTemplateOverrides: overrides,
        instancesDistribution: {
          onDemandPercentageAboveBaseCapacity: 0,       // 100% spot
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
          spotMaxPrice,
        },
      },
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 0,
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(20) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
      defaultInstanceWarmup: cdk.Duration.minutes(20),
      terminationPolicies: [autoscaling.TerminationPolicy.OLDEST_INSTANCE],
    });
    cdk.Tags.of(asg).add('Name', 'coldbones-gpu');
    this.asgName = asg.autoScalingGroupName;

    // ─── Lifecycle hook: LAUNCHING ─────────────────────────────────────────
    // lifecycle_manager Lambda listens on SNS and completes the hook after
    // the vLLM health check passes.  Back-stop: 20 min → CONTINUE (won't
    // serve if vLLM is still loading, but won't stall forever either).
    new autoscaling.LifecycleHook(this, 'LaunchHook', {
      autoScalingGroup: asg,
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_LAUNCHING,
      heartbeatTimeout: cdk.Duration.minutes(20),
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      notificationTarget: new cdk.aws_autoscaling_hooktargets.TopicHook(
        props.notificationTopic,
      ),
      lifecycleHookName: 'coldbones-gpu-launch',
    });

    // ─── Lifecycle hook: TERMINATING ─────────────────────────────────────────
    new autoscaling.LifecycleHook(this, 'TerminateHook', {
      autoScalingGroup: asg,
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      heartbeatTimeout: cdk.Duration.minutes(5),
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      notificationTarget: new cdk.aws_autoscaling_hooktargets.TopicHook(
        props.notificationTopic,
      ),
      lifecycleHookName: 'coldbones-gpu-terminate',
    });

    // ─── SSM Parameters ───────────────────────────────────────────────────
    // Placeholder values — overwritten by lifecycle_manager Lambda on each launch.
    new ssm.StringParameter(this, 'GpuIpParam', {
      parameterName: this.gpuIpParamName,
      stringValue: 'not-yet-assigned',
      description: 'Private IP of the running GPU EC2 instance',
    });

    new ssm.StringParameter(this, 'GpuPortParam', {
      parameterName: this.gpuPortParamName,
      stringValue: String(vllmPort),
      description: 'vLLM HTTP port on the GPU instance',
    });

    new ssm.StringParameter(this, 'AsgNameParam', {
      parameterName: this.asgNameParamName,
      stringValue: asg.autoScalingGroupName,
      description: 'GPU ASG name (used by schedule_manager)',
    });

    new ssm.StringParameter(this, 'ModelNameParam', {
      parameterName: '/coldbones/gpu-model',
      stringValue: model,
      description: 'Served model name / HF model id',
    });

    // ─── CloudWatch: idle inference alarm → scale to 0 ────────────────────
    // vLLM exposes /metrics (prometheus). We use a custom metric emitted by
    // the batch_processor Lambda ("InferenceRequests") and asg desired alarms.
    const idleAlarm = new cloudwatch.Alarm(this, 'IdleAlarm', {
      alarmName: 'coldbones-gpu-idle',
      metric: new cloudwatch.Metric({
        namespace: 'Coldbones/GPU',
        metricName: 'InferenceRequests',
        dimensionsMap: { ASG: asg.autoScalingGroupName },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: Math.ceil(idleShutdownMinutes / 5),
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `GPU idle for ${idleShutdownMinutes} min → scale to 0`,
    });
    idleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.notificationTopic));

    // ─── CloudWatch: CPU high alarm ────────────────────────────────────────
    new cloudwatch.Alarm(this, 'CpuHighAlarm', {
      alarmName: 'coldbones-gpu-cpu-high',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 90,
      evaluationPeriods: 3,
      alarmDescription: 'GPU CPU >90% for 15 min',
    });

    // ─── CloudWatch log group ─────────────────────────────────────────────
    new logs.LogGroup(this, 'GpuStartupLogs', {
      logGroupName: '/coldbones/gpu-startup',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GpuAsgName', {
      value: this.asgName,
      exportName: 'ColdbonesGpuAsgName',
    });
    new cdk.CfnOutput(this, 'ModelVolumeId', {
      value: volumeId,
      exportName: 'ColdbonesModelVolumeId',
      description: 'Persistent EBS volume storing model weights — DO NOT DELETE',
    });
    new cdk.CfnOutput(this, 'GpuIpParamOut', {
      value: this.gpuIpParamName,
      description: 'SSM param holding current GPU private IP',
    });
  }
}
