#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as ec2Types from 'aws-cdk-lib/aws-ec2';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';
import { QueueStack } from '../lib/queue-stack';
import { ModelStack } from '../lib/model-stack';
import { SpotModelStack } from '../lib/spot-model-stack';
import { ApiStack } from '../lib/api-stack';
import { ScheduleStack } from '../lib/schedule-stack';

const app = new cdk.App();

// ── Environment ──────────────────────────────────────────────────────────────
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// ── Config from cdk.json context ──────────────────────────────────────────────
const ctx = app.node.tryGetContext('coldbones') ?? {};
const overnightShutdownHour: number = ctx.overnightShutdownHour ?? 23;
const morningWarmupHour: number = ctx.morningWarmupHour ?? 7;
const timezone: string = ctx.timezone ?? 'America/New_York';
const enableWeekendFastShutdown: boolean = ctx.enableWeekendFastShutdown ?? false;
const fastInstanceType = ctx.fastGpuInstanceType ?? 'g5.2xlarge';
const slowInstanceType = ctx.slowGpuInstanceType ?? 'g5.2xlarge';
const modelQuant: string = ctx.modelQuant ?? 'Q4_K_M';
const budgetAlertThresholdUsd: number = ctx.budgetAlertThresholdUsd ?? 200;
const billingEmail: string | undefined = ctx.billingEmail;
const openaiKeyParam: string | undefined = ctx.openaiKeyParam ?? '/coldbones/openai-api-key';

// ── Tags (applied to all stacks) ─────────────────────────────────────────────
const tags: Record<string, string> = {
  Project: 'Coldbones',
  ManagedBy: 'CDK',
};

function tagStack(s: cdk.Stack): void {
  Object.entries(tags).forEach(([k, v]) => cdk.Tags.of(s).add(k, v));
}

// ── Stack 1: Network ─────────────────────────────────────────────────────────
const networkStack = new NetworkStack(app, 'ColdbonesNetwork', { env });
tagStack(networkStack);

// ── Stack 2: Storage ─────────────────────────────────────────────────────────
const storageStack = new StorageStack(app, 'ColdbonesStorage', { env });
tagStack(storageStack);

// ── Stack 3: Queue + Step Functions ──────────────────────────────────────────
const queueStack = new QueueStack(app, 'ColdbonesQueue', { env });
queueStack.addDependency(storageStack);
tagStack(queueStack);

// ── Stack 4: Fast-mode GPU (On-Demand) ────────────────────────────────────────
const modelStack = new ModelStack(app, 'ColdbonesModel', {
  env,
  vpc: networkStack.vpc,
  gpuSecurityGroup: networkStack.gpuSecurityGroup,
  modelBucket: storageStack.uploadBucket,
  instanceType: new ec2Types.InstanceType(fastInstanceType),
  modelQuant,
  openaiKeyParamName: openaiKeyParam,
});
modelStack.addDependency(networkStack);
modelStack.addDependency(storageStack);
tagStack(modelStack);

// ── Stack 5: Slow-mode GPU (Spot) ─────────────────────────────────────────────
const spotModelStack = new SpotModelStack(app, 'ColdbonesSpotModel', {
  env,
  vpc: networkStack.vpc,
  gpuSecurityGroup: networkStack.gpuSecurityGroup,
  notificationTopic: queueStack.notificationTopic,
  instanceTypes: [
    new ec2Types.InstanceType(slowInstanceType),
    new ec2Types.InstanceType('g4dn.2xlarge'),
    new ec2Types.InstanceType('g4ad.2xlarge'),
  ],
  modelQuant,
  openaiKeyParamName: openaiKeyParam,
});
spotModelStack.addDependency(networkStack);
spotModelStack.addDependency(queueStack);
tagStack(spotModelStack);

// ── Stack 6: API Gateway + Lambdas ────────────────────────────────────────────
const apiStack = new ApiStack(app, 'ColdbonesApi', {
  env,
  vpc: networkStack.vpc,
  lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
  uploadBucket: storageStack.uploadBucket,
  jobsTable: storageStack.jobsTable,
  connectionsTable: storageStack.connectionsTable,
  analysisQueue: queueStack.analysisQueue,
  notificationTopic: queueStack.notificationTopic,
  stateMachine: queueStack.stateMachine,
  fastAsgName: modelStack.asgName,
  slowAsgName: spotModelStack.asgName,
  openaiApiKeyParam: openaiKeyParam,
});
apiStack.addDependency(networkStack);
apiStack.addDependency(storageStack);
apiStack.addDependency(queueStack);
apiStack.addDependency(modelStack);
apiStack.addDependency(spotModelStack);
tagStack(apiStack);

// ── Stack 7: Scheduling + Alarms + Dashboard ──────────────────────────────────
const scheduleStack = new ScheduleStack(app, 'ColdbonesSchedule', {
  env,
  fastAsgName: modelStack.asgName,
  slowAsgName: spotModelStack.asgName,
  notificationTopic: queueStack.notificationTopic,
  overnightShutdownHour,
  morningWarmupHour,
  timezone,
  enableWeekendFastShutdown,
  budgetAlertThresholdUsd,
  billingEmail,
});
scheduleStack.addDependency(modelStack);
scheduleStack.addDependency(spotModelStack);
scheduleStack.addDependency(queueStack);
tagStack(scheduleStack);

app.synth();
