import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
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

    // SSM: read desktop Tailscale Funnel URL
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/coldbones/*`],
    }));

    // Lambda:Invoke — router invokes orchestrator
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:*`],
    }));

    // ─── Common env ─────────────────────────────────────────────────────────
    const sharedEnv: Record<string, string> = {
      UPLOAD_BUCKET:        props.uploadBucket.bucketName,
      JOBS_TABLE:           props.jobsTable.tableName,
      ANALYZE_QUEUE_URL:    props.analysisQueue.queueUrl,
      DESKTOP_URL_PARAM:    desktopUrlParam,
      DESKTOP_PORT_PARAM:   desktopPortParam,
      MODEL_NAME:           modelName,
      POWERTOOLS_SERVICE_NAME: 'coldbones',
    };

    // ─── Lambda builder ────────────────────────────────────────────────────
    const fn = (id: string, dir: string, extra?: Partial<lambda.FunctionProps>) => {
      const dirPath = path.join(lambdaRoot, dir);
      const reqFile = path.join(dirPath, 'requirements.txt');
      const hasDeps = fs.existsSync(reqFile);
      const desktopClientSrc = path.join(lambdaRoot, 'desktop_client.py');

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
                    // Include shared desktop_client module
                    if (fs.existsSync(desktopClientSrc)) {
                      execSync(`cp "${desktopClientSrc}" "${outputDir}/desktop_client.py"`);
                    }
                    return true;
                  } catch { return false; }
                },
              },
            },
          })
        : lambda.Code.fromAsset(dirPath, {
            // For handlers without requirements.txt, still copy desktop_client.py in
            assetHashType: cdk.AssetHashType.SOURCE,
            bundling: {
              image: lambda.Runtime.PYTHON_3_12.bundlingImage,
              command: ['bash', '-c', 'cp -au . /asset-output'],
              local: {
                tryBundle(outputDir: string): boolean {
                  try {
                    execSync(`cp -r "${dirPath}/." "${outputDir}"`);
                    if (fs.existsSync(desktopClientSrc)) {
                      execSync(`cp "${desktopClientSrc}" "${outputDir}/desktop_client.py"`);
                    }
                    return true;
                  } catch { return false; }
                },
              },
            },
          });

      return new lambda.Function(this, id, {
        runtime:      lambda.Runtime.PYTHON_3_12,
        handler:      'handler.handler',
        code,
        timeout:      cdk.Duration.minutes(5),
        memorySize:   512,
        environment:  { ...sharedEnv },
        role:         lambdaRole,
        tracing:      lambda.Tracing.ACTIVE,
        // Explicit retention prevents log groups from accumulating forever
        // (Lambda auto-creates log groups with no retention by default).
        // CloudWatch Logs: $0.50/GB ingested + $0.03/GB/month stored.
        logRetention: logs.RetentionDays.ONE_WEEK,
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
      provider:     'LM Studio (desktop RTX 5090 via Tailscale)',
    });
    const healthFn = new lambda.Function(this, 'HealthFn', {
      runtime:   lambda.Runtime.PYTHON_3_12,
      handler:   'index.handler',
      code:      lambda.Code.fromInline(
        `import json\nBODY = '${healthBody.replace(/'/g, "\\'")}'\n` +
        `def handler(event, context):\n` +
        `    return {"statusCode": 200, "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, "body": BODY}\n`,
      ),
      timeout:      cdk.Duration.seconds(5),
      memorySize:   128,
      logRetention: logs.RetentionDays.ONE_WEEK,
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

    // Named 'v1' stage with throttling.
    // Throttle: 20 req/s sustained, 50 burst — the desktop processes one job
    // at a time so accepting more requests just queues them or returns errors.
    const stage = new apigwv2.HttpStage(this, 'Stage', {
      httpApi:    this.httpApi,
      stageName:  'v1',
      autoDeploy: true,
      throttle: {
        rateLimit:  20,
        burstLimit: 50,
      },
    });

    // ─── Routes ─────────────────────────────────────────────────────────────
    // PayloadFormatVersion 1.0 keeps the Lambda event shape identical to the
    // old REST API proxy format (event.body, event.pathParameters, etc.) so
    // no handler code changes are needed.

    this.httpApi.addRoutes({
      path:        '/api/health',
      methods:     [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HealthInteg', healthFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
      }),
    });

    this.httpApi.addRoutes({
      path:        '/api/presign',
      methods:     [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('PresignInteg', presignedUrlFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
      }),
    });

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

    this.httpApi.addRoutes({
      path:        '/api/status/{jobId}',
      methods:     [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('StatusInteg', jobStatusFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
      }),
    });

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
  }
}
