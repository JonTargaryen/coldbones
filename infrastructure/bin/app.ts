#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';
import { QueueStack } from '../lib/queue-stack';
import { NetworkStack } from '../lib/network-stack';
import { GpuStack } from '../lib/gpu-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();

// ── Environment ───────────────────────────────────────────────────────────────
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// ── Config from cdk.json context ──────────────────────────────────────────────
const ctx = app.node.tryGetContext('coldbones') ?? {};
const domainName: string | undefined = ctx.domainName;
const appSubdomain: string | undefined = ctx.appSubdomain;
const gpuCtx = ctx.gpu ?? {};

const gpuConfig = {
  model:                 gpuCtx.model              ?? 'Qwen/Qwen3.5-35B-A3B-AWQ',
  vllmPort:              Number(gpuCtx.vllmPort     ?? 8000),
  maxModelLen:           Number(gpuCtx.maxModelLen  ?? 16384),
  instanceTypes:         gpuCtx.instanceTypes       ?? ['g6e.2xlarge', 'g5.12xlarge', 'p3.8xlarge'],
  useSpot:               gpuCtx.useSpot             ?? true,
  spotMaxPrice:          gpuCtx.spotMaxPriceUsd     ?? '2.50',
  dataVolumeGib:         Number(gpuCtx.dataVolumeGib ?? 250),
  idleShutdownMinutes:   Number(gpuCtx.idleShutdownMinutes ?? 30),
  overnightShutdownHour: Number(gpuCtx.overnightShutdownHour ?? 23),
  morningWarmupHour:     Number(gpuCtx.morningWarmupHour ?? 7),
  enableWeekendShutdown: gpuCtx.enableWeekendShutdown ?? true,
};

// ── Tags ──────────────────────────────────────────────────────────────────────
function tag(s: cdk.Stack): void {
  cdk.Tags.of(s).add('Project', 'Coldbones');
  cdk.Tags.of(s).add('ManagedBy', 'CDK');
}

// ── Stack 1: Storage (S3, CloudFront, Route53, DynamoDB) ─────────────────────
const storageStack = new StorageStack(app, 'ColdbonesStorage', {
  env,
  domainName,
  appSubdomain,
});
tag(storageStack);

// ── Stack 2: Async Queue (SQS + SNS) ─────────────────────────────────────────
const queueStack = new QueueStack(app, 'ColdbonesQueue', { env });
queueStack.addDependency(storageStack);
tag(queueStack);

// ── Stack 3: Network (VPC, SGs, VPC Endpoints) ───────────────────────────────
const networkStack = new NetworkStack(app, 'ColdbonesNetwork', { env });
networkStack.addDependency(storageStack);
tag(networkStack);

// ── Stack 4: Cloud GPU (vLLM + persistent EBS + lifecycle + schedule) ─────────
const gpuStack = new GpuStack(app, 'ColdbonesGpu', {
  env,
  vpc: networkStack.vpc,
  gpuSecurityGroup: networkStack.gpuSecurityGroup,
  notificationTopic: queueStack.notificationTopic,
  uploadBucket: storageStack.uploadBucket,
  ...gpuConfig,
});
gpuStack.addDependency(networkStack);
gpuStack.addDependency(queueStack);
tag(gpuStack);

// ── Stack 5: API + Lambdas ────────────────────────────────────────────────────
const apiStack = new ApiStack(app, 'ColdbonesApi', {
  env,
  uploadBucket: storageStack.uploadBucket,
  jobsTable: storageStack.jobsTable,
  analysisQueue: queueStack.analysisQueue,
  notificationTopic: queueStack.notificationTopic,
  vpc: networkStack.vpc,
  lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
  gpuIpParamName: gpuStack.gpuIpParamName,
  gpuPortParamName: gpuStack.gpuPortParamName,
  gpuAsgNameParamName: gpuStack.asgNameParamName,
  // gpuAsgName intentionally omitted — Lambda reads from SSM at runtime via GPU_ASG_PARAM
  modelName: gpuConfig.model,
});
apiStack.addDependency(storageStack);
apiStack.addDependency(queueStack);
apiStack.addDependency(networkStack);
apiStack.addDependency(gpuStack);
tag(apiStack);

app.synth();

