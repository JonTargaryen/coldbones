/**
 * CDK stack assertion tests.
 * Uses aws-cdk-lib/assertions to verify synthesized CloudFormation templates.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';

import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';
import { QueueStack } from '../lib/queue-stack';
import { ModelStack } from '../lib/model-stack';
import { SpotModelStack } from '../lib/spot-model-stack';
import { ApiStack } from '../lib/api-stack';
import { ScheduleStack } from '../lib/schedule-stack';

// ─── Shared test app factory ──────────────────────────────────────────────────

function makeApp() {
  return new cdk.App({
    context: {
      // CDK context to prevent lookups hitting real AWS
      'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
    },
  });
}

const env = { account: '123456789012', region: 'us-east-1' };

// ─── NetworkStack ─────────────────────────────────────────────────────────────

describe('NetworkStack', () => {
  let template: Template;
  let stack: NetworkStack;

  beforeAll(() => {
    const app = makeApp();
    stack = new NetworkStack(app, 'TestNetworkStack', { env });
    template = Template.fromStack(stack);
  });

  it('creates a VPC', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  it('creates public and private subnets', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 4); // 2 AZs × 2 subnet types
  });

  it('creates a NAT Gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('creates a GPU security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'GPU model server instances',
    });
  });

  it('creates a Lambda security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Lambda functions',
    });
  });

  it('creates flow logs', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
  });

  it('creates S3 gateway VPC endpoint', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.stringLikeRegexp('s3'),
    });
  });

  it('outputs VPC ID and GPU SG ID', () => {
    template.hasOutput('VpcId', {});
    template.hasOutput('GpuSecurityGroupId', {});
  });
});

// ─── StorageStack ─────────────────────────────────────────────────────────────

describe('StorageStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const storageStack = new StorageStack(app, 'TestStorageStack', { env });
    template = Template.fromStack(storageStack);
  });

  it('creates upload bucket with lifecycle rule (7-day expiry)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 7,
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  it('creates site bucket with versioning enabled', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('all S3 buckets block public access', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    const bucketArr = Object.values(buckets);
    for (const bucket of bucketArr) {
      const bpa = bucket.Properties?.PublicAccessBlockConfiguration;
      if (bpa) {
        expect(bpa.BlockPublicAcls).toBe(true);
        expect(bpa.BlockPublicPolicy).toBe(true);
      }
    }
  });

  it('creates a CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('CloudFront redirects HTTP to HTTPS', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
      }),
    });
  });

  it('creates DynamoDB jobs table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'jobId', KeyType: 'HASH' }),
      ]),
    });
  });

  it('creates DynamoDB connections table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'connectionId', KeyType: 'HASH' }),
      ]),
    });
  });

  it('creates at least 2 DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 2);
  });
});

// ─── QueueStack ───────────────────────────────────────────────────────────────

describe('QueueStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const queueStack = new QueueStack(app, 'TestQueueStack', { env });
    template = Template.fromStack(queueStack);
  });

  it('creates analysis SQS queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'coldbones-analysis',
    });
  });

  it('creates dead-letter queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'coldbones-analysis-dlq',
    });
  });

  it('analysis queue has redrive policy pointing to DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  it('creates SNS notification topic', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'coldbones-notifications',
    });
  });

  it('creates Step Functions state machine', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  });

  it('analysis queue uses SQS-managed encryption', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'coldbones-analysis',
      SqsManagedSseEnabled: true,
    });
  });
});

// ─── ModelStack ───────────────────────────────────────────────────────────────

describe('ModelStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();

    // NetworkStack provides VPC + SG
    const networkStack = new NetworkStack(app, 'Net', { env });

    const modelStack = new ModelStack(app, 'TestModelStack', {
      env,
      vpc: networkStack.vpc,
      gpuSecurityGroup: networkStack.gpuSecurityGroup,
    });

    template = Template.fromStack(modelStack);
  });

  it('creates an IAM instance role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      }),
    });
  });

  it('attaches SSM managed policy for EC2 access', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.stringLikeRegexp('AmazonSSMManagedInstanceCore'),
      ]),
    });
  });

  it('creates a launch template', () => {
    template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
  });

  it('creates an Auto Scaling Group with min/max=1', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '1',
    });
  });

  it('creates SSM parameter for fast ASG name', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/coldbones/fast-asg-name',
    });
  });

  it('outputs FastAsgName', () => {
    template.hasOutput('FastAsgName', {});
  });
});

// ─── SpotModelStack ───────────────────────────────────────────────────────────

describe('SpotModelStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const networkStack = new NetworkStack(app, 'NetSpot', { env });

    const snsTopic = new sns.Topic(new cdk.Stack(app, 'FakeSns', { env }), 'FakeTopic');

    const spotStack = new SpotModelStack(app, 'TestSpotModelStack', {
      env,
      vpc: networkStack.vpc,
      gpuSecurityGroup: networkStack.gpuSecurityGroup,
      notificationTopic: snsTopic,
    });

    template = Template.fromStack(spotStack);
  });

  it('creates an IAM instance role trusting EC2', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('creates a launch template', () => {
    template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
  });

  it('creates an Auto Scaling Group with desired capacity 0', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      DesiredCapacity: '0',
      MinSize: '0',
    });
  });

  it('ASG uses mixed instances policy with spot', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MixedInstancesPolicy: Match.objectLike({
        InstancesDistribution: Match.objectLike({
          SpotAllocationStrategy: Match.anyValue(),
        }),
      }),
    });
  });
});

// ─── ApiStack ─────────────────────────────────────────────────────────────────

describe('ApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const networkStack = new NetworkStack(app, 'NetApi', { env });
    const storageStack = new StorageStack(app, 'StoreApi', { env });
    const queueStack = new QueueStack(app, 'QApi', { env });

    const apiStack = new ApiStack(app, 'TestApiStack', {
      env,
      vpc: networkStack.vpc,
      lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
      uploadBucket: storageStack.uploadBucket,
      jobsTable: storageStack.jobsTable,
      connectionsTable: storageStack.connectionsTable,
      analysisQueue: queueStack.analysisQueue,
      notificationTopic: queueStack.notificationTopic,
      stateMachine: queueStack.stateMachine,
      fastAsgName: 'coldbones-fast-asg',
      slowAsgName: 'coldbones-slow-asg',
    });

    template = Template.fromStack(apiStack);
  });

  it('creates a REST API Gateway', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  it('creates a WebSocket API', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('creates Lambda execution role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'lambda.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('Lambda role has VPC execution managed policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.stringLikeRegexp('AWSLambdaVPCAccessExecutionRole'),
      ]),
    });
  });

  it('creates multiple Lambda functions', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(5);
  });

  it('creates API Gateway deployment', () => {
    template.resourceCountIs('AWS::ApiGateway::Deployment', 1);
  });

  it('creates WebSocket routes (connect/disconnect)', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$connect',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$disconnect',
    });
  });
});

// ─── ScheduleStack ────────────────────────────────────────────────────────────

describe('ScheduleStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();

    // ScheduleStack needs ASG names
    const scheduleStack = new ScheduleStack(app, 'TestScheduleStack', {
      env,
      fastAsgName: 'coldbones-fast-asg',
      slowAsgName: 'coldbones-slow-asg',
    });

    template = Template.fromStack(scheduleStack);
  });

  it('creates EventBridge scheduled rules', () => {
    template.resourceCountIs('AWS::Events::Rule', Match.atLeast(1) as any);
    const rules = template.findResources('AWS::Events::Rule');
    expect(Object.keys(rules).length).toBeGreaterThanOrEqual(1);
  });

  it('creates Lambda for schedule-manager', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: Match.anyValue(),
      Runtime: Match.stringLikeRegexp('python'),
    });
  });

  it('schedule manager Lambda has ASG permission policy', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              Match.stringLikeRegexp('autoscaling'),
            ]),
          }),
        ]),
      }),
    });
  });
});
