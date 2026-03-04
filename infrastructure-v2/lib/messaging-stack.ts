import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export class MessagingStack extends cdk.Stack {
  public readonly analysisQueue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly notificationTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.dlq = new sqs.Queue(this, 'AnalysisDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.analysisQueue = new sqs.Queue(this, 'AnalysisQueue', {
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.notificationTopic = new sns.Topic(this, 'NotificationTopic');

    new cdk.CfnOutput(this, 'AnalysisQueueUrl', { value: this.analysisQueue.queueUrl });
    new cdk.CfnOutput(this, 'NotificationTopicArn', { value: this.notificationTopic.topicArn });
  }
}
