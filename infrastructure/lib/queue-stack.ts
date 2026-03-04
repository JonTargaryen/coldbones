import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import * as path from 'path';

export interface QueueStackProps extends cdk.StackProps {
  /** ARN of the batch processor Lambda */
  batchProcessorArn?: string;
}

export class QueueStack extends cdk.Stack {
  public readonly analysisQueue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly notificationTopic: sns.Topic;
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props?: QueueStackProps) {
    super(scope, id, props);

    // ─── Dead-Letter Queue ────────────────────────────────────────────────
    this.dlq = new sqs.Queue(this, 'AnalysisDlq', {
      queueName: 'coldbones-analysis-dlq',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    // ─── Analysis Queue ────────────────────────────────────────────────────
    this.analysisQueue = new sqs.Queue(this, 'AnalysisQueue', {
      queueName: 'coldbones-analysis',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20), // long-polling
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    });

    // ─── SNS: Job Notifications ────────────────────────────────────────────
    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: 'coldbones-notifications',
      displayName: 'Coldbones Job Notifications',
    });

    // ─── Step Functions: Slow-Mode Orchestrator ────────────────────────────
    const aslDefinitionPath = path.join(
      __dirname,
      '../../step-functions/slow-mode-orchestrator.asl.json',
    );

    this.stateMachine = new sfn.StateMachine(this, 'SlowModeOrchestrator', {
      stateMachineName: 'coldbones-slow-mode-orchestrator',
      definitionBody: sfn.DefinitionBody.fromFile(aslDefinitionPath),
      timeout: cdk.Duration.hours(6),
      logs: {
        destination: new cdk.aws_logs.LogGroup(this, 'SfnLogs', {
          logGroupName: '/coldbones/sfn/slow-mode',
          retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // ─── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'QueueUrl', {
      value: this.analysisQueue.queueUrl,
      exportName: 'ColdbonesQueueUrl',
    });
    new cdk.CfnOutput(this, 'TopicArn', {
      value: this.notificationTopic.topicArn,
      exportName: 'ColdbonesTopicArn',
    });
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      exportName: 'ColdbonesStateMachineArn',
    });
  }
}
