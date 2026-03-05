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
// Concrete API Gateway hostname — stored in cdk.json context so that
// StorageStack can add the CloudFront /api/* behavior without a circular
// cross-stack dependency. Populated from ColdbonesApi.ApiUrl after first deploy.
const apiGatewayDomain: string | undefined = ctx.apiGatewayDomain;
const apiGatewayStageName: string | undefined = ctx.apiGatewayStageName;

// ── Tags ──────────────────────────────────────────────────────────────────────
function tag(s: cdk.Stack): void {
  cdk.Tags.of(s).add('Project', 'Coldbones');
  cdk.Tags.of(s).add('ManagedBy', 'CDK');
}

// ── Stack 1: Storage (S3, CloudFront, Route53, DynamoDB) ─────────────────────
// This stack owns all the persistent and serving infrastructure.
// It is deployed first because ApiStack's Lambda functions need the bucket
// name and DynamoDB table ARN as environment variables at deploy time.
//
// apiGatewayDomain is read from cdk.json context and stored as a plain string
// (not a CDK cross-stack token) so that StorageStack can add the CloudFront
// /api/* behavior without creating a circular dependency:
//   StorageStack needs ApiStack's domain  →  ApiStack needs StorageStack's bucket
// Plain string breaks that cycle.  After the first 'deploy.sh api', copy the
// hostname from scripts/cdk-outputs.json → ColdbonesApi.ApiUrl and set
// cdk.json["coldbones"]["apiGatewayDomain"] to that value.
const storageStack = new StorageStack(app, 'ColdbonesStorage', {
  env,
  domainName,
  appSubdomain,
  apiGatewayDomain,
  apiGatewayStageName,
});
tag(storageStack);

// ── Stack 2: Async Queue (SQS) ────────────────────────────────────────────────
// SQS is the durability buffer between the API and the desktop worker.
// When the desktop is offline, analyze_router writes jobs here instead of
// invoking the orchestrator.  The desktop worker long-polls this queue
// and processes jobs whenever it's running.  The queue has a 14-day
// message retention period and a dead-letter queue for failed messages.
const queueStack = new QueueStack(app, 'ColdbonesQueue', { env });
queueStack.addDependency(storageStack);
tag(queueStack);

// ── Stack 3: API + Lambdas ────────────────────────────────────────────────────
// Lambdas call the desktop LM Studio via Tailscale Funnel (public HTTPS),
// so no VPC is needed — Lambda has outbound internet access by default and
// Tailscale Funnel exposes the desktop over a stable public URL.
//
// Deploy order note: ApiStack depends on StorageStack (for bucket + table
// references) and QueueStack (for queue URL).  CDK enforces this via
// addDependency() calls below, which generate CloudFormation DependsOn entries.
const apiStack = new ApiStack(app, 'ColdbonesApi', {
  env,
  uploadBucket:  storageStack.uploadBucket,
  jobsTable:     storageStack.jobsTable,
  analysisQueue: queueStack.analysisQueue,
  userPool:      storageStack.userPool,
  userPoolClient: storageStack.userPoolClient,
  modelName,
});
apiStack.addDependency(storageStack);
apiStack.addDependency(queueStack);
tag(apiStack);

app.synth();

