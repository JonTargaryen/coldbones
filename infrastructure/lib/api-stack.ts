import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ApiStackProps extends cdk.StackProps {
  uploadBucket: s3.IBucket;
  jobsTable: dynamodb.ITable;
  analysisQueue: sqs.IQueue;
  notificationTopic: sns.ITopic;
  /**
   * Base URL of the LM Studio instance running Qwen3.5 on Seratonin via
   * Tailscale Funnel (e.g. 'https://seratonin.tail40ae2c.ts.net').
   * Lambdas will call <lmStudioUrl>/v1/chat/completions.
   */
  lmStudioUrl: string;
  /** CORS origins. Default: '*' */
  allowedOrigins?: string[];
}

export class ApiStack extends cdk.Stack {
  public readonly restApi: apigw.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const lambdaRoot = path.join(__dirname, '../../lambdas');
    const allowedOrigins = props.allowedOrigins ?? ['*'];

    // ─── Shared Lambda execution role ──────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    });

    // S3, DynamoDB, SQS, SNS grants
    props.uploadBucket.grantReadWrite(lambdaRole);
    props.jobsTable.grantReadWriteData(lambdaRole);
    props.analysisQueue.grantSendMessages(lambdaRole);
    props.analysisQueue.grantConsumeMessages(lambdaRole);
    props.notificationTopic.grantPublish(lambdaRole);

    // ─── Shared env ────────────────────────────────────────────────────────
    const sharedEnv: Record<string, string> = {
      UPLOAD_BUCKET: props.uploadBucket.bucketName,
      JOBS_TABLE: props.jobsTable.tableName,
      ANALYZE_QUEUE_URL: props.analysisQueue.queueUrl,
      SNS_TOPIC_ARN: props.notificationTopic.topicArn,
      LM_STUDIO_URL: props.lmStudioUrl,
      // LM Studio uses OpenAI-compat API — no real key needed, but some
      // clients require a non-empty value.
      LM_STUDIO_API_KEY: 'lm-studio',
      POWERTOOLS_SERVICE_NAME: 'coldbones',
    };

    // ─── Lambda helper ─────────────────────────────────────────────────────
    // NOTE: logRetention is intentionally omitted here — adding it with a shared
    // role creates a CloudFormation circular dependency (the retention custom
    // resource adds the function ARN to the role's policy, but the function
    // already depends on that role).  Retention is managed via explicit LogGroup
    // resources below instead.
    const fn = (id: string, dir: string, extra?: Partial<lambda.FunctionProps>) =>
      new lambda.Function(this, id, {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(path.join(lambdaRoot, dir)),
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        environment: { ...sharedEnv },
        role: lambdaRole,
        tracing: lambda.Tracing.ACTIVE,
        ...extra,
      });

    // ─── Lambda Functions ──────────────────────────────────────────────────

    const presignedUrlFn = fn('PresignedUrlFn', 'get_presigned_url', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });

    const analyzeOrchestratorFn = fn('AnalyzeOrchestratorFn', 'analyze_orchestrator', {
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
    });

    const analyzeRouterFn = fn('AnalyzeRouterFn', 'analyze_router', {
      timeout: cdk.Duration.minutes(6),
      memorySize: 256,
    });
    // grantInvoke(lambdaRole) would create a cycle (function depends on role;
    // role policy would reference the function ARN).  Use a wildcard instead.
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:*`],
    }));
    analyzeRouterFn.addEnvironment('ORCHESTRATOR_FUNCTION', analyzeOrchestratorFn.functionName);

    const batchProcessorFn = fn('BatchProcessorFn', 'batch_processor', {
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
    });

    batchProcessorFn.addEventSource(
      new eventsources.SqsEventSource(props.analysisQueue as sqs.Queue, {
        batchSize: 1,
        enabled: true,
        reportBatchItemFailures: true,
      }),
    );

    const jobStatusFn = fn('JobStatusFn', 'job_status', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });

    // ─── REST API ──────────────────────────────────────────────────────────
    const accessLog = new logs.LogGroup(this, 'ApiAccessLog', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.restApi = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'coldbones-api',
      description: 'Coldbones REST API — LM Studio inference via Tailscale Funnel',
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 20,
        throttlingBurstLimit: 50,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLog),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        tracingEnabled: true,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const api = this.restApi.root.addResource('api');

    // GET /api/health — checks that LM Studio is reachable
    const health = api.addResource('health');
    health.addMethod('GET', new apigw.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: {
          'application/json': JSON.stringify({
            status: 'ok',
            model: 'qwen3.5',
            provider: 'LM Studio (Seratonin)',
            lm_studio_url: props.lmStudioUrl,
            model_loaded: true,
          }),
        },
      }],
      passthroughBehavior: apigw.PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), {
      methodResponses: [{ statusCode: '200' }],
    });

    // POST /api/presign
    const presign = api.addResource('presign');
    presign.addMethod('POST', new apigw.LambdaIntegration(presignedUrlFn));

    // POST /api/analyze
    const analyze = api.addResource('analyze');
    analyze.addMethod('POST', new apigw.LambdaIntegration(analyzeRouterFn, {
      timeout: cdk.Duration.seconds(29),
    }));

    // GET /api/status/{jobId}
    const status = api.addResource('status');
    const statusJobId = status.addResource('{jobId}');
    statusJobId.addMethod('GET', new apigw.LambdaIntegration(jobStatusFn));

    // ─── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.restApi.url,
      description: 'API Gateway URL — set VITE_API_BASE_URL to this value',
      exportName: 'ColdbonesApiUrl',
    });
    new cdk.CfnOutput(this, 'LmStudioUrl', {
      value: props.lmStudioUrl,
      description: 'LM Studio Tailscale Funnel URL used by Lambdas',
    });
  }
}
