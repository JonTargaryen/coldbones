#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { RuntimeStack } from '../lib/runtime-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
};

const tag = (stack: cdk.Stack): void => {
  cdk.Tags.of(stack).add('Project', 'Coldbones');
  cdk.Tags.of(stack).add('Track', 'V2');
  cdk.Tags.of(stack).add('ManagedBy', 'CDK');
};

const foundationStack = new FoundationStack(app, 'ColdbonesV2Foundation', { env });
const messagingStack = new MessagingStack(app, 'ColdbonesV2Messaging', { env });
const runtimeStack = new RuntimeStack(app, 'ColdbonesV2Runtime', { env });
const apiStack = new ApiStack(app, 'ColdbonesV2Api', { env });

apiStack.addDependency(foundationStack);
apiStack.addDependency(messagingStack);
apiStack.addDependency(runtimeStack);

[foundationStack, messagingStack, runtimeStack, apiStack].forEach(tag);

app.synth();
