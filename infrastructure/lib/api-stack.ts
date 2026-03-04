import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
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
  public readonly restApi: apigw.RestApi;

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
        runtime:     lambda.Runtime.PYTHON_3_12,
        handler:     'handler.handler',
        code,
        timeout:     cdk.Duration.minutes(5),
        memorySize:  512,
        environment: { ...sharedEnv },
        role:        lambdaRole,
        tracing:     lambda.Tracing.ACTIVE,
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
      memorySize: 512,
    });

    const analyzeRouterFn = fn('AnalyzeRouterFn', 'analyze_router', {
      timeout:    cdk.Duration.minutes(11),
      memorySize: 256,
    });
    analyzeRouterFn.addEnvironment('ORCHESTRATOR_FUNCTION_ARN', analyzeOrchestratorFn.functionArn);

    const jobStatusFn = fn('JobStatusFn', 'job_status', {
      timeout:    cdk.Duration.seconds(10),
      memorySize: 128,
    });

    // ─── REST API ──────────────────────────────────────────────────────────────
    // Throttle: 20 req/s sustained, 50 burst.  The desktop can only process
    // one inference at a time, so there's no point accepting more requests
    // than that.  The limits protect both the Lambda concurrency quota and the
    // desktop GPU from being overwhelmed by runaway clients.
    //
    // CORS defaultCorsPreflightOptions:
    //   API Gateway handles OPTIONS preflight automatically when this is set.
    //   Without it, browsers would block all cross-origin requests even though
    //   our Lambda responses include Access-Control-Allow-Origin: *.
    //   (CloudFront forwards CORS headers from the origin, so both the
    //   Lambda and APIGW need to agree on the allowed origins.)
    const accessLog = new logs.LogGroup(this, 'ApiAccessLog', {
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.restApi = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'coldbones-api',
      description: 'Coldbones REST API — inference on desktop RTX 5090 via Tailscale',
      deployOptions: {
        stageName:               'v1',
        throttlingRateLimit:     20,
        throttlingBurstLimit:    50,
        accessLogDestination:    new apigw.LogGroupLogDestination(accessLog),
        accessLogFormat:         apigw.AccessLogFormat.jsonWithStandardFields(),
        tracingEnabled:          true,
        metricsEnabled:          true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        maxAge:       cdk.Duration.hours(1),
      },
    });

    const api = this.restApi.root.addResource('api');

    // GET /api/health
    // GET /api/health  ── Mock integration (no Lambda)
    // A mock integration returns a static response directly from API Gateway
    // without invoking any Lambda.  It costs $0 (no Lambda invocations) and
    // has zero cold-start latency.
    //
    // model_loaded: true tells the frontend's health-check gate that the
    // backend is ready to accept work.  The frontend disables the upload zone
    // when this is false or missing (health === null).
    //
    // Note: The actual LM Studio liveness is checked only when a file is
    // submitted (analyze_router calls is_desktop_alive()).  This health
    // endpoint is intentionally a lightweight "API is deployed" check, not a
    // "GPU is running" check, to avoid adding 4 s of Tailscale latency to
    // every page load.
    const health = api.addResource('health');
    health.addMethod('GET', new apigw.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: {
          'application/json': JSON.stringify({
            status:       'ok',
            model_loaded: true,
            model:        modelName,
            provider:     'LM Studio (desktop RTX 5090 via Tailscale)',
          }),
        },
      }],
      passthroughBehavior:   apigw.PassthroughBehavior.NEVER,
      requestTemplates:      { 'application/json': '{"statusCode": 200}' },
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
    const status    = api.addResource('status');
    const statusJob = status.addResource('{jobId}');
    statusJob.addMethod('GET', new apigw.LambdaIntegration(jobStatusFn));

    // ─── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value:       this.restApi.url,
      description: 'REST API URL — set as VITE_API_BASE_URL',
      exportName:  'ColdbonesApiUrl',
    });
  }
}
