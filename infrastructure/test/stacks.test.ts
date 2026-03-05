import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { QueueStack } from '../lib/queue-stack';
import { ApiStack } from '../lib/api-stack';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): cdk.App {
  return new cdk.App({ context: { domainName: undefined } });
}

// ---------------------------------------------------------------------------
// StorageStack
// ---------------------------------------------------------------------------

describe('StorageStack', () => {
  let template: Template;

  beforeEach(() => {
    const app = makeApp();
    const stack = new StorageStack(app, 'TestStorage', {});
    template = Template.fromStack(stack);
  });

  test('creates versioned upload S3 bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('creates DynamoDB table with PAY_PER_REQUEST billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('creates a CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  test('creates two S3 buckets (upload + site)', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });
});

// ---------------------------------------------------------------------------
// QueueStack
// ---------------------------------------------------------------------------

describe('QueueStack', () => {
  let stack: QueueStack;
  let template: Template;

  beforeEach(() => {
    const app = makeApp();
    stack = new QueueStack(app, 'TestQueue');
    template = Template.fromStack(stack);
  });

  test('exposes analysisQueue property', () => {
    expect(stack.analysisQueue).toBeDefined();
  });

  test('exposes dlq property', () => {
    expect(stack.dlq).toBeDefined();
  });

  test('exposes notificationTopic (SNS) property', () => {
    expect(stack.notificationTopic).toBeDefined();
  });

  test('creates two SQS queues (main + DLQ)', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  test('creates an SNS topic', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  test('main queue has a redrive policy pointing to DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: Match.anyValue(),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// ApiStack
// ---------------------------------------------------------------------------

describe('ApiStack', () => {
  let template: Template;

  beforeEach(() => {
    const app = makeApp();

    const storage = new StorageStack(app, 'TestStorage2', {});
    const queue = new QueueStack(app, 'TestQueue2');

    const api = new ApiStack(app, 'TestApi', {
      uploadBucket: storage.uploadBucket,
      jobsTable: storage.jobsTable,
      analysisQueue: queue.analysisQueue,
      userPool: storage.userPool,
      userPoolClient: storage.userPoolClient,
      modelName: 'Qwen/Qwen3.5-35B-A3B-AWQ',
    });

    template = Template.fromStack(api);
  });

  test('creates a REST API Gateway', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  test('creates Lambda functions for each handler', () => {
    // presign, orchestrator, router, job_status
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: Match.stringLikeRegexp('python3') },
    });
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(4);
  });

  test('Lambda functions have DESKTOP_URL_PARAM environment variable', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: Match.stringLikeRegexp('python3') },
    });
    const hasDesktopParam = Object.values(fns).some((fn: any) => {
      const envVars = fn.Properties?.Environment?.Variables ?? {};
      return 'DESKTOP_URL_PARAM' in envVars;
    });
    expect(hasDesktopParam).toBe(true);
  });
});
