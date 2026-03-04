import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ApiStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  lambdaSecurityGroup: ec2.ISecurityGroup;
  uploadBucket: s3.IBucket;
  jobsTable: dynamodb.ITable;
  connectionsTable: dynamodb.ITable;
  analysisQueue: sqs.IQueue;
  notificationTopic: sns.ITopic;
  stateMachine: sfn.IStateMachine;
  fastAsgName: string;
  slowAsgName: string;
  gpuEndpointSsmParam?: string;
  openaiApiKeyParam?: string;
}

export class ApiStack extends cdk.Stack {
  public readonly restApi: apigw.RestApi;
  public readonly wsApi: apigwv2.WebSocketApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const lambdaRoot = path.join(__dirname, '../../lambdas');

    // ─── Shared Lambda environment ─────────────────────────────────────────
    const sharedEnv: Record<string, string> = {
      UPLOAD_BUCKET: props.uploadBucket.bucketName,
      JOBS_TABLE: props.jobsTable.tableName,
      CONNECTIONS_TABLE: props.connectionsTable.tableName,
      QUEUE_URL: props.analysisQueue.queueUrl,
      TOPIC_ARN: props.notificationTopic.topicArn,
      STATE_MACHINE_ARN: props.stateMachine.stateMachineArn,
      FAST_ASG_NAME: props.fastAsgName,
      SLOW_ASG_NAME: props.slowAsgName,
      GPU_ENDPOINT: props.gpuEndpointSsmParam
        ? `ssm:${props.gpuEndpointSsmParam}`
        : 'http://localhost:8080',
      POWERTOOLS_SERVICE_NAME: 'coldbones',
    };

    // ─── Shared Lambda execution role ─────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    });

    // Grants
    props.uploadBucket.grantReadWrite(lambdaRole);
    props.jobsTable.grantReadWriteData(lambdaRole);
    props.connectionsTable.grantReadWriteData(lambdaRole);
    props.analysisQueue.grantSendMessages(lambdaRole);
    props.analysisQueue.grantConsumeMessages(lambdaRole);
    props.notificationTopic.grantPublish(lambdaRole);
    props.stateMachine.grantStartExecution(lambdaRole);

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:SetDesiredCapacity',
        'autoscaling:TerminateInstanceInAutoScalingGroup',
      ],
      resources: ['*'],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    if (props.openaiApiKeyParam) {
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${props.openaiApiKeyParam}`,
        ],
      }));
    }

    // ─── Lambda helper ─────────────────────────────────────────────────────
    const fn = (id: string, dir: string, extra?: Partial<lambda.FunctionProps>) =>
      new lambda.Function(this, id, {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(path.join(lambdaRoot, dir)),
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        environment: sharedEnv,
        role: lambdaRole,
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [props.lambdaSecurityGroup],
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logs.RetentionDays.ONE_WEEK,
        ...extra,
      });

    // ─── Lambda Functions ──────────────────────────────────────────────────

    const presignedUrlFn = fn('PresignedUrlFn', 'get_presigned_url', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
    });

    const analyzeRouterFn = fn('AnalyzeRouterFn', 'analyze_router', {
      timeout: cdk.Duration.minutes(10),
    });

    const analyzeOrchestratorFn = fn('AnalyzeOrchestratorFn', 'analyze_orchestrator', {
      timeout: cdk.Duration.minutes(10),
    });

    // Allow analyze_router to invoke analyze_orchestrator synchronously
    analyzeOrchestratorFn.grantInvoke(lambdaRole);
    sharedEnv['ORCHESTRATOR_FUNCTION_NAME'] = analyzeOrchestratorFn.functionName;
    analyzeRouterFn.addEnvironment(
      'ORCHESTRATOR_FUNCTION_NAME',
      analyzeOrchestratorFn.functionName,
    );

    const batchProcessorFn = fn('BatchProcessorFn', 'batch_processor', {
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
    });

    // SQS trigger for batch processor
    batchProcessorFn.addEventSource(
      new eventsources.SqsEventSource(props.analysisQueue as sqs.Queue, {
        batchSize: 1,
        enabled: true,
      }),
    );

    const jobStatusFn = fn('JobStatusFn', 'job_status', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
    });

    const lifecycleManagerFn = fn('LifecycleManagerFn', 'lifecycle_manager', {
      timeout: cdk.Duration.minutes(5),
    });

    const wsConnectFn = fn('WsConnectFn', 'ws_connect', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      vpc: undefined, // WS connect/disconnect don't need VPC
      vpcSubnets: undefined,
      securityGroups: undefined,
    });
    wsConnectFn.addEnvironment('CONNECTIONS_TABLE', props.connectionsTable.tableName);

    const wsDisconnectFn = fn('WsDisconnectFn', 'ws_disconnect', {
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      vpc: undefined,
      vpcSubnets: undefined,
      securityGroups: undefined,
    });
    wsDisconnectFn.addEnvironment('CONNECTIONS_TABLE', props.connectionsTable.tableName);

    const wsNotifyFn = fn('WsNotifyFn', 'ws_notify', {
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      vpc: undefined,
      vpcSubnets: undefined,
      securityGroups: undefined,
    });

    // SNS → ws_notify
    props.notificationTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(wsNotifyFn),
    );

    // ─── REST API (API Gateway) ────────────────────────────────────────────
    const accessLog = new logs.LogGroup(this, 'ApiAccessLog', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.restApi = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'coldbones-api',
      description: 'Coldbones REST API',
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 10,
        throttlingBurstLimit: 50,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLog),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        tracingEnabled: true,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // POST /presign
    this.restApi.root
      .addResource('presign')
      .addMethod('POST', new apigw.LambdaIntegration(presignedUrlFn));

    // POST /analyze
    this.restApi.root
      .addResource('analyze')
      .addMethod('POST', new apigw.LambdaIntegration(analyzeRouterFn));

    // GET /status/{jobId}
    const statusResource = this.restApi.root.addResource('status');
    statusResource
      .addResource('{jobId}')
      .addMethod('GET', new apigw.LambdaIntegration(jobStatusFn));

    // GET /health
    this.restApi.root.addResource('health').addMethod(
      'GET',
      new apigw.MockIntegration({
        integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }],
        passthroughBehavior: apigw.PassthroughBehavior.NEVER,
        requestTemplates: { 'application/json': '{"statusCode":200}' },
      }),
      { methodResponses: [{ statusCode: '200' }] },
    );

    // ─── WebSocket API ─────────────────────────────────────────────────────
    this.wsApi = new apigwv2.WebSocketApi(this, 'WsApi', {
      apiName: 'coldbones-ws',
      connectRouteOptions: {
        integration: new apigwv2int.WebSocketLambdaIntegration('WsConnect', wsConnectFn),
      },
      disconnectRouteOptions: {
        integration: new apigwv2int.WebSocketLambdaIntegration('WsDisconnect', wsDisconnectFn),
      },
      defaultRouteOptions: {
        integration: new apigwv2int.WebSocketLambdaIntegration('WsDefault', wsNotifyFn),
      },
    });

    const wsStage = new apigwv2.WebSocketStage(this, 'WsStage', {
      webSocketApi: this.wsApi,
      stageName: 'v1',
      autoDeploy: true,
    });

    // Give ws_notify AGA management permission
    wsNotifyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${this.wsApi.apiId}/${wsStage.stageName}/*`,
      ],
    }));

    wsNotifyFn.addEnvironment('WS_ENDPOINT', wsStage.callbackUrl);

    // ─── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RestApiUrl', {
      value: this.restApi.url,
      exportName: 'ColdbonesApiUrl',
    });
    new cdk.CfnOutput(this, 'WsApiUrl', {
      value: wsStage.url,
      exportName: 'ColdbonesWsUrl',
    });
  }
}
