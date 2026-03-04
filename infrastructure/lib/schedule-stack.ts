import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ScheduleStackProps extends cdk.StackProps {
  fastAsgName: string;
  slowAsgName: string;
  notificationTopic: sns.ITopic;
  /** hour (24h, local timezone) to shutdown overnight — default 23 */
  overnightShutdownHour?: number;
  /** hour (24h) to warm up in the morning — default 7 */
  morningWarmupHour?: number;
  /** IANA timezone — default America/New_York */
  timezone?: string;
  /** shut down fast-mode GPU on weekends — default false */
  enableWeekendFastShutdown?: boolean;
  /** USD — monthly budget alert threshold */
  budgetAlertThresholdUsd?: number;
  /** email for billing alerts */
  billingEmail?: string;
}

export class ScheduleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ScheduleStackProps) {
    super(scope, id, props);

    const {
      overnightShutdownHour = 23,
      morningWarmupHour = 7,
      timezone = 'America/New_York',
      enableWeekendFastShutdown = false,
      budgetAlertThresholdUsd = 200,
    } = props;

    // ─── Lambda: schedule_manager ─────────────────────────────────────────
    const scheduleFn = new lambda.Function(this, 'ScheduleFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../lambdas/schedule_manager'),
      ),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        FAST_ASG_NAME: props.fastAsgName,
        SLOW_ASG_NAME: props.slowAsgName,
        TOPIC_ARN: props.notificationTopic.topicArn,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    scheduleFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:SetDesiredCapacity',
        'autoscaling:UpdateAutoScalingGroup',
      ],
      resources: ['*'],
    }));
    props.notificationTopic.grantPublish(scheduleFn);

    // ─── EventBridge Rules ────────────────────────────────────────────────

    // Overnight shutdown — weekdays only (fast + slow)
    new events.Rule(this, 'OvernightShutdownRule', {
      ruleName: 'coldbones-overnight-shutdown',
      description: `Shut down GPU instances at ${overnightShutdownHour}:00`,
      // Note: CDK EventBridge cron runs in UTC; adjust hours accordingly
      schedule: events.Schedule.cron({
        minute: '0',
        hour: String(overnightShutdownHour),
        weekDay: 'MON-FRI',
      }),
      targets: [
        new targets.LambdaFunction(scheduleFn, {
          event: events.RuleTargetInput.fromObject({
            action: 'OVERNIGHT_SHUTDOWN',
            shutdownFast: true,
            shutdownSlow: true,
          }),
        }),
      ],
    });

    // Morning warmup — weekdays only (fast only)
    new events.Rule(this, 'MorningWarmupRule', {
      ruleName: 'coldbones-morning-warmup',
      description: `Start fast-mode GPU at ${morningWarmupHour}:00`,
      schedule: events.Schedule.cron({
        minute: '0',
        hour: String(morningWarmupHour),
        weekDay: 'MON-FRI',
      }),
      targets: [
        new targets.LambdaFunction(scheduleFn, {
          event: events.RuleTargetInput.fromObject({
            action: 'MORNING_WARMUP',
            startFast: true,
            startSlow: false,
          }),
        }),
      ],
    });

    if (enableWeekendFastShutdown) {
      // Friday night extended shutdown
      new events.Rule(this, 'WeekendShutdownRule', {
        ruleName: 'coldbones-weekend-shutdown',
        description: 'Friday night full shutdown',
        schedule: events.Schedule.cron({
          minute: '0',
          hour: '22',
          weekDay: 'FRI',
        }),
        targets: [
          new targets.LambdaFunction(scheduleFn, {
            event: events.RuleTargetInput.fromObject({
              action: 'WEEKEND_SHUTDOWN',
              shutdownFast: true,
              shutdownSlow: true,
            }),
          }),
        ],
      });

      // Monday morning warmup
      new events.Rule(this, 'MondayWarmupRule', {
        ruleName: 'coldbones-monday-warmup',
        description: 'Monday morning GPU warmup',
        schedule: events.Schedule.cron({
          minute: '0',
          hour: String(morningWarmupHour),
          weekDay: 'MON',
        }),
        targets: [
          new targets.LambdaFunction(scheduleFn, {
            event: events.RuleTargetInput.fromObject({
              action: 'MORNING_WARMUP',
              startFast: true,
              startSlow: false,
            }),
          }),
        ],
      });
    }

    // ─── CloudWatch Alarms ────────────────────────────────────────────────

    // API 5xx alarm
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: 'coldbones-api-5xx',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5XXError',
        dimensionsMap: { ApiName: 'coldbones-api' },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 1,
      alarmDescription: 'API Gateway 5xx errors > 10 in 5 min',
    }).addAlarmAction(new cloudwatchActions.SnsAction(props.notificationTopic));

    // DLQ message alarm
    new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: 'coldbones-dlq-messages',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        dimensionsMap: { QueueName: 'coldbones-analysis-dlq' },
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'Jobs landing in DLQ',
    }).addAlarmAction(new cloudwatchActions.SnsAction(props.notificationTopic));

    // CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'Coldbones',
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Latency (p99)',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: 'IntegrationLatency',
          dimensionsMap: { ApiName: 'coldbones-api' },
          statistic: 'p99',
          period: cdk.Duration.minutes(5),
        })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Queue Depth',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/SQS',
          metricName: 'ApproximateNumberOfMessagesVisible',
          dimensionsMap: { QueueName: 'coldbones-analysis' },
          statistic: 'Maximum',
          period: cdk.Duration.minutes(1),
        })],
        width: 12,
      }),
    );

    // ─── AWS Budgets ───────────────────────────────────────────────────────
    if (props.billingEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: budgetAlertThresholdUsd, unit: 'USD' },
          budgetName: 'coldbones-monthly',
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: 'ACTUAL',
              comparisonOperator: 'GREATER_THAN',
              threshold: 80,
              thresholdType: 'PERCENTAGE',
            },
            subscribers: [
              { subscriptionType: 'EMAIL', address: props.billingEmail },
            ],
          },
          {
            notification: {
              notificationType: 'FORECASTED',
              comparisonOperator: 'GREATER_THAN',
              threshold: 100,
              thresholdType: 'PERCENTAGE',
            },
            subscribers: [
              { subscriptionType: 'EMAIL', address: props.billingEmail },
            ],
          },
        ],
      });
    }
  }
}
