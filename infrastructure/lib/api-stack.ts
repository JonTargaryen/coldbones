import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export interface ApiStackProps extends cdk.StackProps {
  uploadBucket: s3.IBucket;
  jobsTable: dynamodb.ITable;
  analysisQueue: sqs.IQueue;

  // Desktop SSM params (Tailscale Funnel URL)
  desktopUrlParamName?: string;   // default: /coldbones/desktop-url
  desktopPortParamName?: string;  // default: /coldbones/desktop-port

  // Bedrock CMI
  bedrockModelArnParamName?: string; // default: /coldbones/bedrock-model-arn

  // Model
  modelName?: string;

  /** CORS origins. Default: '*' */
  allowedOrigins?: string[];
}

export class ApiStack extends cdk.Stack {
  // HTTP API V2 — 71% cheaper than REST API ($1.00 vs $3.50 per million requests).
  // Switched from REST API (apigw.RestApi) because:
  //   - We don't use API keys, usage plans, request validators, or authorizers
  //     — features that justify REST API's higher price.
  //   - The mock integration for /api/health (the only REST-API-specific feature
  //     we used) is replaced by a trivial inline Lambda that costs <$0.00001/month.
  //   - HTTP API supports per-route Lambda integrations, throttling, CORS, and
  //     access logging — everything we need.
  //   - The named 'v1' stage keeps CloudFront's originPath: '/v1' unchanged,
  //     so StorageStack needs no update for existing CloudFront distributions.
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const lambdaRoot          = path.join(__dirname, '../../lambdas');
    const allowedOrigins      = props.allowedOrigins ?? ['*'];
    const modelName           = props.modelName ?? 'Qwen/Qwen3.5-35B-A3B-AWQ';
    const desktopUrlParam     = props.desktopUrlParamName  ?? '/coldbones/desktop-url';
    const desktopPortParam    = props.desktopPortParamName ?? '/coldbones/desktop-port';
    const bedrockModelArnParam = props.bedrockModelArnParamName ?? '/coldbones/bedrock-model-arn';

    // ─── Shared Lambda role ────────────────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    });

    props.uploadBucket.grantReadWrite(lambdaRole);
    props.jobsTable.grantReadWriteData(lambdaRole);
    props.analysisQueue.grantSendMessages(lambdaRole);

    // SSM: read desktop Tailscale Funnel URL + Bedrock model ARN
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/coldbones/*`],
    }));

    // Lambda:Invoke — router invokes orchestrator (scoped after fn creation)

    // Bedrock: invoke imported custom model (CMI — legacy path)
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:GetImportedModel'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:imported-model/*`],
    }));

    // Bedrock On-Demand: invoke the configured model via Converse API.
    // Scoped to the specific model ID rather than foundation-model/*
    // to follow the principle of least privilege.
    const bedrockModelId = 'qwen.qwen3-vl-235b-a22b';
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/${bedrockModelId}`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        `arn:aws:bedrock:us:${this.account}:inference-profile/*`,
      ],
    }));

    // ─── Common env ─────────────────────────────────────────────────────────
    const sharedEnv: Record<string, string> = {
      UPLOAD_BUCKET:        props.uploadBucket.bucketName,
      JOBS_TABLE:           props.jobsTable.tableName,
      ANALYZE_QUEUE_URL:    props.analysisQueue.queueUrl,
      DESKTOP_URL_PARAM:    desktopUrlParam,
      DESKTOP_PORT_PARAM:   desktopPortParam,
      BEDROCK_MODEL_ARN_PARAM: bedrockModelArnParam,
      BEDROCK_ONDEMAND_MODEL_ID: 'qwen.qwen3-vl-235b-a22b',
      MODEL_NAME:           modelName,
      POWERTOOLS_SERVICE_NAME: 'coldbones',
    };

    // ─── Shared client module paths ────────────────────────────────────────
    const desktopClientSrc = path.join(lambdaRoot, 'desktop_client.py');
    const bedrockClientSrc = path.join(lambdaRoot, 'bedrock_client.py');
    const bedrockOndemandClientSrc = path.join(lambdaRoot, 'bedrock_ondemand_client.py');
    const loggerSrc = path.join(lambdaRoot, 'logger.py');

    /** Copy shared client modules into a bundle output directory. */
    const copySharedClients = (outputDir: string) => {
      for (const src of [desktopClientSrc, bedrockClientSrc, bedrockOndemandClientSrc, loggerSrc]) {
        if (fs.existsSync(src)) {
          execSync(`cp "${src}" "${outputDir}/"`);
        }
      }
    };

    // ─── Lambda builder ────────────────────────────────────────────────────
    // Uses ARM64 (Graviton2) — ~20% cheaper per GB-second and ~34% better
    // price-performance than x86_64 for Python workloads.  All our Lambdas
    // are pure Python + boto3 (no native compiled extensions that require
    // x86), so ARM64 works without code changes.
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
                      ` --platform manylinux2014_aarch64` +
                      ` --only-binary :all:` +
                      ` --implementation cp --python-version 312 --quiet`,
                      { stdio: 'inherit' },
                    );
                    execSync(`cp -r "${dirPath}/." "${outputDir}"`);
                    copySharedClients(outputDir);
                    return true;
                  } catch { return false; }
                },
              },
            },
          })
        : lambda.Code.fromAsset(dirPath, {
            assetHashType: cdk.AssetHashType.SOURCE,
            bundling: {
              image: lambda.Runtime.PYTHON_3_12.bundlingImage,
              command: ['bash', '-c', 'cp -au . /asset-output'],
              local: {
                tryBundle(outputDir: string): boolean {
                  try {
                    execSync(`cp -r "${dirPath}/." "${outputDir}"`);
                    copySharedClients(outputDir);
                    return true;
                  } catch { return false; }
                },
              },
            },
          });

      return new lambda.Function(this, id, {
        runtime:      lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        handler:      'handler.handler',
        code,
        timeout:      cdk.Duration.minutes(5),
        memorySize:   512,
        environment:  { ...sharedEnv },
        role:         lambdaRole,
        tracing:      lambda.Tracing.ACTIVE,
        // Explicit log group prevents CloudWatch from creating one with no
        // retention. CloudWatch Logs: $0.50/GB ingested + $0.03/GB/month stored.
        logGroup: new logs.LogGroup(this, `${id}LogGroup`, {
          retention:     logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        ...extra,
      });
    };

    // ─── Lambda functions ──────────────────────────────────────────────────

    const presignedUrlFn = fn('PresignedUrlFn', 'get_presigned_url', {
      timeout:    cdk.Duration.seconds(10),
      memorySize: 128,
    });

    const analyzeOrchestratorFn = fn('AnalyzeOrchestratorFn', 'analyze_orchestrator', {
      timeout:    cdk.Duration.minutes(10),
      // 256 MB is sufficient — orchestrator makes HTTP calls to Tailscale/LM
      // Studio and waits; no image processing happens inside Lambda. Halving
      // from 512 MB saves ~50% on GB-second cost per invocation.
      memorySize: 256,
    });

    const analyzeRouterFn = fn('AnalyzeRouterFn', 'analyze_router', {
      // Router writes one DynamoDB item + fires an async Lambda invoke and
      // returns 202. That takes <3 s. The 29 s API Gateway hard limit already
      // caps the HTTP response, but a hanging Lambda would waste compute for
      // up to the old 11-minute timeout. 30 s cuts that waste.
      timeout:    cdk.Duration.seconds(30),
      memorySize: 256,
    });
    analyzeRouterFn.addEnvironment('ORCHESTRATOR_FUNCTION_ARN', analyzeOrchestratorFn.functionArn);

    // Scoped Lambda:Invoke — only router → orchestrator.
    // We use a separate inline policy (not the shared role's DefaultPolicy)
    // to avoid a circular dependency: DefaultPolicy would need the orchestrator
    // ARN (Ref), but the orchestrator DependsOn DefaultPolicy.
    new iam.Policy(this, 'RouterInvokePolicy', {
      roles: [lambdaRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [analyzeOrchestratorFn.functionArn],
        }),
      ],
    });


    const jobStatusFn = fn('JobStatusFn', 'job_status', {
      timeout:    cdk.Duration.seconds(10),
      memorySize: 128,
    });

    // ─── Health Lambda ──────────────────────────────────────────────────────
    // HTTP API has no mock integration (that was a REST API feature), so we
    // use a tiny inline Lambda instead. Inline code avoids a deploy artifact
    // and the function itself is ~5 lines — no external dependencies needed.
    // At our traffic level this costs effectively $0 (well within free tier).
    const healthBody = JSON.stringify({
      status:       'ok',
      model_loaded: true,
      model:        modelName,
      provider:     'Bedrock On-Demand (cloud-primary)',
      providers: {
        cloud: { name: 'Bedrock On-Demand (Qwen3 VL 235B)', status: 'configured', default: true },
        local: { name: 'RTX 5090 (LM Studio)', status: 'configured' },
        'cloud-cmi': { name: 'Bedrock CMI (Qwen2.5-VL)', status: 'configured' },
      },
    });
    const healthFn = new lambda.Function(this, 'HealthFn', {
      runtime:      lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler:      'index.handler',
      code:      lambda.Code.fromInline(
        `import json\nBODY = '${healthBody.replace(/'/g, "\\'")}'\n` +
        `def handler(event, context):\n` +
        `    return {"statusCode": 200, "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, "body": BODY}\n`,
      ),
      timeout:      cdk.Duration.seconds(5),
      memorySize:   128,
      logGroup: new logs.LogGroup(this, 'HealthFnLogGroup', {
        retention:     logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ─── HTTP API V2 ───────────────────────────────────────────────────────
    // corsPreflight: HTTP API handles OPTIONS automatically when this is set,
    // just like REST API's defaultCorsPreflightOptions did.
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName:    'coldbones-api',
      description: 'Coldbones HTTP API — inference on desktop RTX 5090 via Tailscale',
      // Disable the auto-created $default stage so we can create a named 'v1'
      // stage below.  This keeps the CloudFront originPath: '/v1' unchanged —
      // no cdk.json update needed after switching from REST → HTTP API.
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        maxAge:       cdk.Duration.hours(1),
      },
    });

    // Named 'v1' stage with throttling and access logging.
    // Throttle: 20 req/s sustained, 50 burst — the desktop processes one job
    // at a time so accepting more requests just queues them or returns errors.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLog', {
      logGroupName: '/coldbones/api-access',
      retention:     logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stage = new apigwv2.HttpStage(this, 'Stage', {
      httpApi:    this.httpApi,
      stageName:  'v1',
      autoDeploy: true,
      throttle: {
        rateLimit:  20,
        burstLimit: 50,
      },
    });

    // Access logging — CfnStage override for detailed request/response auditing
    const cfnStage = stage.node.defaultChild as cdk.CfnResource;
    cfnStage.addPropertyOverride('AccessLogSettings', {
      DestinationArn: accessLogGroup.logGroupArn,
      Format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        caller: '$context.identity.caller',
        user: '$context.identity.user',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        resourcePath: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        integrationLatency: '$context.integrationLatency',
        integrationStatus: '$context.integrationStatus',
        errorMessage: '$context.error.message',
      }),
    });

    // ─── Routes ─────────────────────────────────────────────────────────────
    // PayloadFormatVersion 1.0 keeps the Lambda event shape identical to the
    // old REST API proxy format (event.body, event.pathParameters, etc.) so
    // no handler code changes are needed.

    // Health: used by monitoring and the initial health check
    this.httpApi.addRoutes({
      path:        '/api/health',
      methods:     [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HealthInteg', healthFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
      }),
    });

    // Presign
    this.httpApi.addRoutes({
      path:        '/api/presign',
      methods:     [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('PresignInteg', presignedUrlFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
      }),
    });

    // Analyze
    this.httpApi.addRoutes({
      path:        '/api/analyze',
      methods:     [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('AnalyzeInteg', analyzeRouterFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
        // HTTP API max integration timeout is 30 s — same practical cap as
        // the old REST API LambdaIntegration timeout of 29 s.
        timeout: cdk.Duration.seconds(29),
      }),
    });

    // Status
    this.httpApi.addRoutes({
      path:        '/api/status/{jobId}',
      methods:     [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('StatusInteg', jobStatusFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
      }),
    });

    // ─── Tags for cost allocation ──────────────────────────────────────────
    cdk.Tags.of(this).add('feature', 'bedrock-ondemand');

    // ─── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value:       `${this.httpApi.apiEndpoint}/v1/`,
      description: 'HTTP API V2 stage URL',
      exportName:  'ColdbonesApiUrl',
    });

    // ApiDomain is the bare hostname needed for CloudFront's apiGatewayDomain
    // in cdk.json context.  After deploying this stack, copy this value into
    // cdk.json → coldbones.apiGatewayDomain, then run: deploy.sh storage
    new cdk.CfnOutput(this, 'ApiDomain', {
      value:       cdk.Fn.select(2, cdk.Fn.split('/', this.httpApi.apiEndpoint)),
      description: 'Hostname only — paste into cdk.json → coldbones.apiGatewayDomain, then run deploy.sh storage',
      exportName:  'ColdbonesApiDomain',
    });

    // ─── CloudWatch Alarms (SNS email) ─────────────────────────────────────
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'ColdBones Alarms',
    });
    alarmTopic.addSubscription(
      new sns_subs.EmailSubscription('soumit.oss@gmail.com'),
    );

    // Lambda error alarms — fire when any function errors ≥ 3 times in 5 min
    const lambdaFns: [string, lambda.Function][] = [
      ['Presign', presignedUrlFn],
      ['Router', analyzeRouterFn],
      ['Orchestrator', analyzeOrchestratorFn],
      ['JobStatus', jobStatusFn],
    ];

    for (const [label, fn] of lambdaFns) {
      const alarm = new cloudwatch.Alarm(this, `${label}ErrorAlarm`, {
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `ColdBones ${label} Lambda errors ≥ 3 in 5 min`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));
    }

    // API Gateway 5xx alarm
    const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: new cloudwatch.Metric({
        namespace:  'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: { ApiId: this.httpApi.apiId },
        statistic:  'Sum',
        period:     cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'ColdBones API 5xx errors ≥ 5 in 5 min',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // ─── CloudWatch Synthetics Canary ──────────────────────────────────────
    // Hits /api/health every 5 minutes to verify the API is reachable.
    // Cost: ~$0.0012/run × 8640 runs/month ≈ $10.37/month.
    const canary = new synthetics.Canary(this, 'HealthCanary', {
      canaryName: 'coldbones-health',
      schedule:   synthetics.Schedule.rate(cdk.Duration.minutes(5)),
      runtime:    synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_13_0,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(`
const https = require('https');
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const apiUrl = process.env.API_URL;

const apiCanaryBlueprint = async function () {
  const url = apiUrl + '/api/health';
  log.info('Canary GET ' + url);
  const res = await new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let body = '';
      r.on('data', (d) => body += d);
      r.on('end', () => resolve({ statusCode: r.statusCode, body }));
      r.on('error', reject);
    }).on('error', reject);
  });
  log.info('Response: ' + res.statusCode + ' ' + res.body);
  if (res.statusCode !== 200) throw new Error('Health check failed: ' + res.statusCode);
  const data = JSON.parse(res.body);
  if (data.status !== 'ok') throw new Error('Unhealthy: ' + JSON.stringify(data));
};

exports.handler = async () => {
  return await apiCanaryBlueprint();
};
        `),
        handler: 'index.handler',
      }),
      environmentVariables: {
        API_URL: this.httpApi.apiEndpoint + '/v1',
      },
      artifactsBucketLocation: {
        bucket: props.uploadBucket,
        prefix: 'canary-artifacts/',
      },
    });

    // Alarm when canary fails ≥ 2 consecutive times
    const canaryAlarm = new cloudwatch.Alarm(this, 'CanaryAlarm', {
      metric: canary.metricFailed({ period: cdk.Duration.minutes(10) }),
      threshold: 2,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'ColdBones health canary failed ≥ 2 times in 10 min',
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    canaryAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));
  }
}
