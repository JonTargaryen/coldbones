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
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// ── Config from cdk.json context ──────────────────────────────────────────────
const ctx = app.node.tryGetContext('coldbones') ?? {};
const domainName: string | undefined = ctx.domainName;
const appSubdomain: string | undefined = ctx.appSubdomain;
// URL of the LM Studio instance on Seratonin (Tailscale Funnel).
// Lambdas POST to <lmStudioUrl>/v1/chat/completions via OpenAI-compat API.
const lmStudioUrl: string = ctx.lmStudioUrl ?? 'https://seratonin.tail40ae2c.ts.net';

// ── Tags ──────────────────────────────────────────────────────────────────────
function tagStack(s: cdk.Stack): void {
  cdk.Tags.of(s).add('Project', 'Coldbones');
  cdk.Tags.of(s).add('ManagedBy', 'CDK');
}

// ── Stack 1: Storage (S3, CloudFront, DynamoDB) ───────────────────────────────
const storageStack = new StorageStack(app, 'ColdbonesStorage', {
  env,
  domainName,
  appSubdomain,
});
tagStack(storageStack);

// ── Stack 2: Async Queue (SQS + SNS) ─────────────────────────────────────────
const queueStack = new QueueStack(app, 'ColdbonesQueue', { env });
queueStack.addDependency(storageStack);
tagStack(queueStack);

// ── Stack 3: API + Lambdas ────────────────────────────────────────────────────
// Lambdas forward inference requests to LM Studio on Seratonin via Tailscale
// Funnel.  No GPU EC2, no Bedrock — just S3 + API GW + Lambda.
const apiStack = new ApiStack(app, 'ColdbonesApi', {
  env,
  uploadBucket: storageStack.uploadBucket,
  jobsTable: storageStack.jobsTable,
  analysisQueue: queueStack.analysisQueue,
  notificationTopic: queueStack.notificationTopic,
  lmStudioUrl,
});
apiStack.addDependency(storageStack);
apiStack.addDependency(queueStack);
tagStack(apiStack);

app.synth();
