import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
    //
    // States:
    //  1. CheckGpuAvailable   — describe ASG desired capacity
    //  2. ScaleUpIfNeeded     — set desired=1 when idle
    //  3. WaitForBoot         — poll /health for up to 20 min
    //  4. ProcessBatch        — invoke batch_processor loop
    //  5. NotifyComplete      — publish to SNS
    //  6. ScaleDownIfIdle     — set desired=0 if queue empty
    //
    // The actual batch_processor Lambda is referenced by ARN; if not
    // provided yet (bootstrapping order), placeholder is used.

    const wait30s = new sfn.Wait(this, 'Wait30s', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForBoot = new sfn.Wait(this, 'WaitForBoot', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    // Pass state — placeholder for GPU-scaling tasks resolved at deploy time
    const checkGpu = new sfn.Pass(this, 'CheckGpu', {
      comment: 'Check GPU ASG capacity — replaced by Lambda task at deploy',
      resultPath: '$.gpuCheck',
      parameters: { status: 'CHECK_PENDING' },
    });

    const scaleUp = new sfn.Pass(this, 'ScaleUpGpu', {
      comment: 'Scale up GPU ASG to desired=1',
      resultPath: '$.scaleUp',
      parameters: { action: 'SCALE_UP' },
    });

    const gpuReady = new sfn.Choice(this, 'GpuReady?');

    const notifyComplete = new sfn.Pass(this, 'NotifyComplete', {
      comment: 'Job complete — ws_notify Lambda sends WebSocket push',
    });

    const jobFailed = new sfn.Fail(this, 'JobFailed', {
      error: 'BatchProcessingError',
      cause: 'Batch processor Lambda encountered an unrecoverable error',
    });

    // ─── Retry config (shared) ─────────────────────────────────────────────
    const retryPolicy: sfn.RetryProps = {
      errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException'],
      interval: cdk.Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    };

    // ─── State machine definition ──────────────────────────────────────────
    // Simplified skeleton — actual Lambda invocations are wired by ApiStack
    // so they can share the Lambda function objects.
    const definition = checkGpu
      .next(
        new sfn.Choice(this, 'IsGpuRunning?')
          .when(
            sfn.Condition.stringEquals('$.gpuCheck.status', 'RUNNING'),
            waitForBoot.next(notifyComplete),
          )
          .otherwise(scaleUp.next(wait30s.next(notifyComplete))),
      );

    this.stateMachine = new sfn.StateMachine(this, 'SlowModeOrchestrator', {
      stateMachineName: 'coldbones-slow-mode-orchestrator',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
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
