import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * ColdbonesQueue — async work delivery for slow-mode analysis.
 *
 * Simplified from the original design: no Step Functions.
 * Slow-mode flow:
 *   analyze_router → SQS → batch_processor (Lambda SQS trigger) → DynamoDB
 *   Frontend polls /api/status/{jobId} until complete.
 */
export class QueueStack extends cdk.Stack {
  public readonly analysisQueue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly notificationTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.dlq = new sqs.Queue(this, 'AnalysisDlq', {
      queueName: 'coldbones-analysis-dlq',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.analysisQueue = new sqs.Queue(this, 'AnalysisQueue', {
      queueName: 'coldbones-analysis',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // Must be >= Lambda timeout for batch processor (15 min)
      visibilityTimeout: cdk.Duration.minutes(16),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    });

    // SNS topic for job-complete notifications (future: email/push alerts)
    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: 'coldbones-notifications',
      displayName: 'Coldbones Job Notifications',
    });

    new cdk.CfnOutput(this, 'QueueUrl', { value: this.analysisQueue.queueUrl, exportName: 'ColdbonesQueueUrl' });
    new cdk.CfnOutput(this, 'TopicArn', { value: this.notificationTopic.topicArn, exportName: 'ColdbonesTopicArn' });
  }
}
