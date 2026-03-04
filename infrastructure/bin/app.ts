#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';
import { QueueStack } from '../lib/queue-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();

// ── Environment ───────────────────────────────────────────────────────────────
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// ── Config from cdk.json context ──────────────────────────────────────────────
const ctx        = app.node.tryGetContext('coldbones') ?? {};
const domainName: string | undefined = ctx.domainName;
const appSubdomain: string | undefined = ctx.appSubdomain;
const modelName: string = ctx.modelName ?? 'Qwen/Qwen3.5-35B-A3B-AWQ';

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

// ── Stack 2: Async Queue (SQS) ────────────────────────────────────────────────
const queueStack = new QueueStack(app, 'ColdbonesQueue', { env });
queueStack.addDependency(storageStack);
tag(queueStack);

// ── Stack 3: API + Lambdas ────────────────────────────────────────────────────
// Lambdas call desktop vLLM via Tailscale Funnel (public HTTPS) — no VPC needed.
const apiStack = new ApiStack(app, 'ColdbonesApi', {
  env,
  uploadBucket: storageStack.uploadBucket,
  jobsTable:    storageStack.jobsTable,
  analysisQueue: queueStack.analysisQueue,
  modelName,
});
apiStack.addDependency(storageStack);
apiStack.addDependency(queueStack);
tag(apiStack);

app.synth();

