import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export interface ApiStackProps extends cdk.StackProps {
  uploadBucket: s3.IBucket;
  jobsTable: dynamodb.ITable;
  analysisQueue: sqs.IQueue;
  notificationTopic: sns.ITopic;

  // VPC (Lambdas run inside so they can reach the GPU)
  vpc: ec2.IVpc;
  lambdaSecurityGroup: ec2.ISecurityGroup;

  // GPU SSM params
  gpuIpParamName: string;         // /coldbones/gpu-ip
  gpuPortParamName: string;       // /coldbones/gpu-port
  gpuAsgNameParamName: string;    // /coldbones/gpu-asg-name
  gpuAsgName?: string;            // for schedule_manager env (optional — falls back to SSM lookup)

  // Model
  modelName?: string;             // served model name

  /** CORS origins. Default: '*' */
  allowedOrigins?: string[];
}

export class ApiStack extends cdk.Stack {
  public readonly restApi: apigw.RestApi;
  public readonly wsApi: apigwv2.WebSocketApi;
  public readonly wsApiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const lambdaRoot = path.join(__dirname, '../../lambdas');
    const allowedOrigins = props.allowedOrigins ?? ['*'];
    const modelName = props.modelName ?? 'Qwen/Qwen3.5-35B-A3B-AWQ';

    // ─── Shared Lambda role ────────────────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    });

    props.uploadBucket.grantReadWrite(lambdaRole);
    props.jobsTable.grantReadWriteData(lambdaRole);
    props.analysisQueue.grantSendMessages(lambdaRole);
    props.analysisQueue.grantConsumeMessages(lambdaRole);
    props.notificationTopic.grantPublish(lambdaRole);

    // SSM: read GPU IP / port
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/coldbones/*`],
    }));

    // Lambda:Invoke (orchestrator invoked by router)
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:*`],
    }));

    // ASG: schedule_manager needs to set desired capacity
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:SetDesiredCapacity',
        'autoscaling:UpdateAutoScalingGroup',
        'autoscaling:CompleteLifecycleAction',
        'autoscaling:RecordLifecycleActionHeartbeat',
        'autoscaling:DescribeAutoScalingInstances',
        'autoscaling:DescribeLifecycleHooks',
      ],
      resources: ['*'],
    }));

    // EC2: lifecycle_manager needs describe instances
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    // CloudWatch: batch_processor emits custom metrics
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // ─── Common env ────────────────────────────────────────────────────────
    const sharedEnv: Record<string, string> = {
      UPLOAD_BUCKET: props.uploadBucket.bucketName,
      JOBS_TABLE: props.jobsTable.tableName,
      ANALYZE_QUEUE_URL: props.analysisQueue.queueUrl,
      SNS_TOPIC_ARN: props.notificationTopic.topicArn,
      GPU_IP_PARAM: props.gpuIpParamName,
      GPU_PORT_PARAM: props.gpuPortParamName,
      GPU_ASG_NAME: props.gpuAsgName ?? '',  // empty → gpu_client falls back to SSM /coldbones/gpu-asg-name
      GPU_ASG_PARAM: props.gpuAsgNameParamName,
      MODEL_NAME: modelName,
      POWERTOOLS_SERVICE_NAME: 'coldbones',
    };

    // ─── VPC config for Lambda ─────────────────────────────────────────────
    const vpcConfig: Partial<lambda.FunctionProps> = {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
    };

    // ─── Lambda builder ────────────────────────────────────────────────────
    const fn = (id: string, dir: string, extra?: Partial<lambda.FunctionProps>) => {
      const dirPath = path.join(lambdaRoot, dir);
      const reqFile = path.join(dirPath, 'requirements.txt');
      const hasDeps = fs.existsSync(reqFile);

      const code = hasDeps
        ? lambda.Code.fromAsset(dirPath, {
            assetHashType: cdk.AssetHashType.OUTPUT,
            bundling: {
              image: lambda.Runtime.PYTHON_3_12.bundlingImage,
              command: [
                'bash', '-c',
                'pip install -r requirements.txt -t /asset-output --quiet && cp -au . /asset-output',
              ],
              local: {
                tryBundle(outputDir: string): boolean {
                  try {
                    execSync(
                      `pip3 install -r "${reqFile}" -t "${outputDir}"` +
                      ` --platform manylinux2014_x86_64` +
                      ` --only-binary :all:` +
                      ` --implementation cp --python-version 312 --quiet`,
                      { stdio: 'inherit' },
                    );
                    execSync(`cp -r "${dirPath}/." "${outputDir}"`);
                    // Include shared gpu_client module used by orchestrator & batch_processor
                    const gpuClientSrc = path.join(lambdaRoot, 'gpu_client.py');
                    if (fs.existsSync(gpuClientSrc)) {
                      execSync(`cp "${gpuClientSrc}" "${outputDir}/gpu_client.py"`);
                    }
                    return true;
                  } catch { return false; }
                },
              },
            },
          })
        : lambda.Code.fromAsset(dirPath);

      return new lambda.Function(this, id, {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        code,
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        environment: { ...sharedEnv },
        role: lambdaRole,
        tracing: lambda.Tracing.ACTIVE,
        ...vpcConfig,
        ...extra,
      });
    };

    // ─── Lambda functions ──────────────────────────────────────────────────

    const presignedUrlFn = fn('PresignedUrlFn', 'get_presigned_url', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });

    const analyzeOrchestratorFn = fn('AnalyzeOrchestratorFn', 'analyze_orchestrator', {
      timeout: cdk.Duration.minutes(10),   // vLLM on large model can take 3-5 min
      memorySize: 512,
    });

    const analyzeRouterFn = fn('AnalyzeRouterFn', 'analyze_router', {
      timeout: cdk.Duration.minutes(11),
      memorySize: 256,
    });
    analyzeRouterFn.addEnvironment('ORCHESTRATOR_FUNCTION_ARN', analyzeOrchestratorFn.functionArn);

    const batchProcessorFn = fn('BatchProcessorFn', 'batch_processor', {
      timeout: cdk.Duration.minutes(14),
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

    const lifecycleFn = fn('LifecycleManagerFn', 'lifecycle_manager', {
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
    });

    const scheduleFn = fn('ScheduleManagerFn', 'schedule_manager', {
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });

    // ─── WebSocket Lambdas (now deployed!) ────────────────────────────────
    const wsConnectionsTable = new dynamodb.Table(this, 'WsConnectionsTable', {
      tableName: 'coldbones-ws-connections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    });
    wsConnectionsTable.addGlobalSecondaryIndex({
      indexName: 'jobId-index',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    wsConnectionsTable.grantReadWriteData(lambdaRole);

    const wsConnectFn = fn('WsConnectFn', 'ws_connect', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });
    wsConnectFn.addEnvironment('CONNECTIONS_TABLE', wsConnectionsTable.tableName);

    const wsDisconnectFn = fn('WsDisconnectFn', 'ws_disconnect', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });
    wsDisconnectFn.addEnvironment('CONNECTIONS_TABLE', wsConnectionsTable.tableName);

    const wsNotifyFn = fn('WsNotifyFn', 'ws_notify', {
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });
    wsNotifyFn.addEnvironment('CONNECTIONS_TABLE', wsConnectionsTable.tableName);

    // ─── WebSocket API Gateway ─────────────────────────────────────────────
    this.wsApi = new apigwv2.WebSocketApi(this, 'WsApi', {
      apiName: 'coldbones-ws',
      description: 'Coldbones real-time job notifications',
      connectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration('WsConnect', wsConnectFn),
      },
      disconnectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration('WsDisconnect', wsDisconnectFn),
      },
    });
    const wsStage = new apigwv2.WebSocketStage(this, 'WsStage', {
      webSocketApi: this.wsApi,
      stageName: 'v1',
      autoDeploy: true,
    });
    this.wsApiUrl = wsStage.url;

    // Allow wsNotify to post back to WebSocket connections
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${this.wsApi.apiId}/*`],
    }));

    // Set WS URL on notify Lambda after wsApi/stage are created
    const wsCallbackUrl = `https://${this.wsApi.apiId}.execute-api.${this.region}.amazonaws.com/${wsStage.stageName}`;
    wsNotifyFn.addEnvironment('WS_GATEWAY_URL', wsCallbackUrl);
    batchProcessorFn.addEnvironment('WS_GATEWAY_URL', wsCallbackUrl);
    analyzeOrchestratorFn.addEnvironment('WS_GATEWAY_URL', wsCallbackUrl);

    // SNS → ws_notify
    props.notificationTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(wsNotifyFn),
    );

    // SNS → lifecycle_manager (for ASG lifecycle hooks)
    props.notificationTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(lifecycleFn),
    );

    // ─── EventBridge scheduled rules (overnight / morning) ────────────────
    const overnightRule = new events.Rule(this, 'OvernightShutdown', {
      ruleName: 'coldbones-overnight-shutdown',
      schedule: events.Schedule.cron({ minute: '0', hour: '4', weekDay: 'MON-FRI' }), // 23 ET = 04 UTC
    });
    overnightRule.addTarget(new eventTargets.LambdaFunction(scheduleFn, {
      event: events.RuleTargetInput.fromObject({ action: 'overnight-shutdown' }),
    }));

    const morningRule = new events.Rule(this, 'MorningWarmup', {
      ruleName: 'coldbones-morning-warmup',
      schedule: events.Schedule.cron({ minute: '0', hour: '12', weekDay: 'MON-FRI' }), // 07 ET = 12 UTC
    });
    morningRule.addTarget(new eventTargets.LambdaFunction(scheduleFn, {
      event: events.RuleTargetInput.fromObject({ action: 'morning-warmup' }),
    }));

    const weekendShutdownRule = new events.Rule(this, 'WeekendShutdown', {
      ruleName: 'coldbones-weekend-shutdown',
      schedule: events.Schedule.cron({ minute: '0', hour: '3', weekDay: 'SAT' }), // Fri 22 ET
    });
    weekendShutdownRule.addTarget(new eventTargets.LambdaFunction(scheduleFn, {
      event: events.RuleTargetInput.fromObject({ action: 'overnight-shutdown' }),
    }));

    const mondayRule = new events.Rule(this, 'MondayWarmup', {
      ruleName: 'coldbones-monday-warmup',
      schedule: events.Schedule.cron({ minute: '0', hour: '12', weekDay: 'MON' }),
    });
    mondayRule.addTarget(new eventTargets.LambdaFunction(scheduleFn, {
      event: events.RuleTargetInput.fromObject({ action: 'morning-warmup' }),
    }));

    // ─── REST API ──────────────────────────────────────────────────────────
    const accessLog = new logs.LogGroup(this, 'ApiAccessLog', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.restApi = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'coldbones-api',
      description: 'Coldbones REST API — vLLM on cloud GPU',
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

    // GET /api/health
    const health = api.addResource('health');
    health.addMethod('GET', new apigw.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: {
          'application/json': JSON.stringify({
            status: 'ok',
            model: modelName,
            provider: 'vLLM on AWS GPU (cloud)',
            model_loaded: true,
          }),
        },
      }],
      passthroughBehavior: apigw.PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), { methodResponses: [{ statusCode: '200' }] });

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

    // POST /api/gpu/start  — trigger GPU scale-up
    const gpu = api.addResource('gpu');
    const gpuStart = gpu.addResource('start');
    gpuStart.addMethod('POST', new apigw.LambdaIntegration(scheduleFn));

    // POST /api/gpu/stop
    const gpuStop = gpu.addResource('stop');
    gpuStop.addMethod('POST', new apigw.LambdaIntegration(scheduleFn));

    // ─── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.restApi.url,
      description: 'REST API URL — set as VITE_API_BASE_URL',
      exportName: 'ColdbonesApiUrl',
    });
    new cdk.CfnOutput(this, 'WsApiUrl', {
      value: this.wsApiUrl,
      description: 'WebSocket URL — set as VITE_WS_URL',
      exportName: 'ColdbonesWsApiUrl',
    });
    new cdk.CfnOutput(this, 'WsCallbackUrl', {
      value: wsCallbackUrl,
      exportName: 'ColdbonesWsCallbackUrl',
    });
  }
}
