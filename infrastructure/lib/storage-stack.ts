import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cfOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';


export interface StorageStackProps extends cdk.StackProps {
  /**
   * Root domain name registered at Squarespace, e.g. "omlahiri.com".
   * When provided, a Route 53 hosted zone + ACM cert will be created and
   * CloudFront will serve the app on app.<domainName> and www.<domainName>.
   *
   * Leave undefined to skip custom domain setup — the CloudFront .cloudfront.net
   * URL still works perfectly for testing.
   */
  domainName?: string;
  /** Sub-domain prefix. Defaults to "app" → app.omlahiri.com */
  appSubdomain?: string;

  /**
   * API Gateway hostname to proxy /api/* through CloudFront, e.g.
   * "la0cszeq83.execute-api.us-east-1.amazonaws.com".
   *
   * Without this, CloudFront routes /api/* to S3 and returns the SPA,
   * causing "Missing Authentication Token" on every API call.
   *
   * Use a concrete string (not a CDK token) to avoid circular stack deps.
   * After first deploying ColdbonesApi, grab the hostname from
   * scripts/cdk-outputs.json → ColdbonesApi.ApiUrl and store it in
   * cdk.json context → coldbones.apiGatewayDomain.
   */
  apiGatewayDomain?: string;
  /** API Gateway stage name. Defaults to "v1". */
  apiGatewayStageName?: string;
}

export class StorageStack extends cdk.Stack {
  public readonly uploadBucket: s3.Bucket;
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly jobsTable: dynamodb.Table;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly hostedZone?: route53.HostedZone;
  public readonly certificate?: acm.Certificate;
  /** https://app.omlahiri.com  OR  https://xxxx.cloudfront.net */
  public readonly appUrl: string;

  constructor(scope: Construct, id: string, props: StorageStackProps = {}) {
    super(scope, id, props);

    const { domainName, appSubdomain = 'app', apiGatewayDomain, apiGatewayStageName = 'v1' } = props;
    const appFqdn = domainName ? `${appSubdomain}.${domainName}` : undefined;

    // ─── Route 53 Hosted Zone + ACM Cert ──────────────────────────────────
    // Only created when domainName is provided.
    // After first deploy: go to Squarespace Domains → Custom Nameservers and
    // paste the 4 NS values from the HostedZoneNameServers stack output.
    let hz: route53.HostedZone | undefined;
    let cert: acm.Certificate | undefined;

    if (domainName) {
      hz = new route53.HostedZone(this, 'HostedZone', {
        zoneName: domainName,
        comment: 'Coldbones production domain',
      });
      this.hostedZone = hz;

      // Certificate must be in us-east-1 for CloudFront — ensure the stack
      // is deployed to us-east-1 (the cdk.json env default).
      cert = new acm.Certificate(this, 'Certificate', {
        domainName: domainName,
        subjectAlternativeNames: [`*.${domainName}`],
        validation: acm.CertificateValidation.fromDns(hz),
      });
      this.certificate = cert;

      new cdk.CfnOutput(this, 'HostedZoneNameServers', {
        value: cdk.Fn.join(', ', hz.hostedZoneNameServers!),
        description:
          '→ Squarespace Domains → omlahiri.com → DNS → Name Servers → Custom → paste these 4 values',
      });
    }

    // ─── S3: Upload Bucket ─────────────────────────────────────────────────────
    // Separate from the site bucket so:
    //   - Different lifecycle/CORS rules can apply independently.
    //   - A misconfigured public-access policy on one doesn't expose the other.
    //   - CloudFront can serve the static site from the site bucket without
    //     any risk of exposing raw uploaded files.
    //
    // Lifecycle: uploads expire after 1 day.  The orchestrator saves the result
    // JSON next to the upload, so keeping the original bytes longer isn't
    // useful.  Aborting incomplete multipart uploads after 1 day prevents
    // orphaned parts from accumulating storage cost.
    //
    // CORS: only PUT and HEAD are needed because the browser reads a presigned
    // PUT URL from our API and then PUTs directly to S3.  GET is handled
    // server-side (Lambda downloads the file; the browser never fetches it).
    this.uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          id: 'expire-uploads',
          expiration: cdk.Duration.days(1),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: [
            'https://app.omlahiri.com',
            'https://www.omlahiri.com',
            'https://omlahiri.com',
            'http://localhost:5173',
          ],
          allowedHeaders: ['Content-Type', 'Content-Length', 'x-amz-*'],
          maxAge: 3600,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── S3: Static Site Bucket ────────────────────────────────────────────
    // Versioning disabled — static SPA build artifacts are fully reproducible.
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── CloudFront Security Headers ─────────────────────────────────────
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: 'coldbones-security-headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' blob: data:",
            "font-src 'self'",
            "connect-src 'self' https://*.execute-api.us-east-1.amazonaws.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        xssProtection: { override: true, protection: true, modeBlock: true },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', override: true, value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    });

    // ─── WAF v2 Web ACL ───────────────────────────────────────────────────
    // AWS WAF protects CloudFront from bots, scanners, SQLi, and abuse.
    // ~$9/mo: $5 base + $1/rule group × 4 rules.
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'coldbones-waf',
        sampledRequestsEnabled: true,
      },
      rules: [
        // Rule 1: AWS Core Rule Set — blocks known bad user agents, path traversal, etc.
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 10,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'core-rules',
            sampledRequestsEnabled: true,
          },
        },
        // Rule 2: Known bad inputs — blocks request patterns associated with exploitation
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'bad-inputs',
            sampledRequestsEnabled: true,
          },
        },
        // Rule 3: SQL injection protection
        {
          name: 'AWSManagedRulesSQLiRuleSet',
          priority: 30,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'sqli-rules',
            sampledRequestsEnabled: true,
          },
        },
        // Rule 4: Per-IP rate limiting — 500 requests per 5 minutes per IP
        {
          name: 'RateLimitPerIP',
          priority: 40,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 500,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'rate-limit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // ─── CloudFront Distribution ───────────────────────────────────────────
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: 'Coldbones SPA OAC',
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: cfOrigins.S3BucketOrigin.withOriginAccessControl(this.siteBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(0) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: webAcl.attrArn,
      ...(appFqdn && cert
        ? { domainNames: [appFqdn, `www.${domainName}`, domainName!], certificate: cert }
        : {}),
    });

    // S3 bucket policy: allow CloudFront OAC
    this.siteBucket.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['s3:GetObject'],
        principals: [new cdk.aws_iam.ServicePrincipal('cloudfront.amazonaws.com')],
        resources: [this.siteBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`,
          },
        },
      }),
    );

    // ─── Route 53 Alias Records ────────────────────────────────────────────
    if (domainName && appFqdn && hz) {
      const cfTarget = new route53Targets.CloudFrontTarget(this.distribution);

      new route53.ARecord(this, 'AppRecord', {
        zone: hz,
        recordName: appSubdomain,
        target: route53.RecordTarget.fromAlias(cfTarget),
      });
      new route53.ARecord(this, 'WwwRecord', {
        zone: hz,
        recordName: 'www',
        target: route53.RecordTarget.fromAlias(cfTarget),
      });
      new route53.ARecord(this, 'ApexRecord', {
        zone: hz,
        recordName: '',
        target: route53.RecordTarget.fromAlias(cfTarget),
      });
    }

    // ─── DynamoDB: Analysis Jobs ───────────────────────────────────────────
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: 'coldbones-jobs',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,  // ~$1.25/million writes
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
      // PITR disabled — jobs are ephemeral, no recovery value vs ~$0.20/GB/month cost.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });

    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'userId-createdAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ─── Cognito User Pool ─────────────────────────────────────────────────
    // Provides authentication for the API. Cognito Hosted UI handles sign-up,
    // sign-in, password reset, and (optionally) MFA. Free tier: 50k MAU.
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'coldbones-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // App client — used by the SPA for OAuth2 PKCE flow (no client secret).
    const callbackUrls = appFqdn
      ? [`https://${appFqdn}/callback`, `https://www.${domainName}/callback`, `https://${domainName}/callback`, 'http://localhost:5173/callback']
      : ['http://localhost:5173/callback'];
    const logoutUrls = appFqdn
      ? [`https://${appFqdn}`, `https://www.${domainName}`, `https://${domainName}`, 'http://localhost:5173']
      : ['http://localhost:5173'];

    this.userPoolClient = this.userPool.addClient('SpaClient', {
      userPoolClientName: 'coldbones-spa',
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Cognito Hosted UI domain
    this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: { domainPrefix: 'coldbones' },
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, exportName: 'ColdbonesUserPoolId' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId, exportName: 'ColdbonesUserPoolClientId' });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `coldbones.auth.${this.region}.amazoncognito.com`,
      exportName: 'ColdbonesCognitoDomain',
    });

    // ─── CloudFront → API Gateway behavior (/api/*) ───────────────────────
    // This must use a CONCRETE hostname string (not a CDK token from ApiStack)
    // to avoid a circular stack dependency:
    //   ColdbonesStorage → ColdbonesApi → ColdbonesStorage (buckets/tables)
    // Set cdk.json context["coldbones"]["apiGatewayDomain"] after first deploy.
    // ─── CloudFront → API Gateway behavior (/api/*) ─────────────────────────────
    // Problem being solved:
    //   Without this behavior, ALL requests (including /api/*) default to the
    //   S3 origin.  S3 returns 403/404 for those paths, which CloudFront maps
    //   to index.html (the SPA fallback).  The browser receives a 200 with
    //   HTML instead of JSON, and API Gateway never sees the request.  This
    //   is why every API call showed "Missing Authentication Token" — that
    //   error comes from API Gateway when a request hits a path/method it
    //   doesn't recognise, but here API Gateway wasn't being reached at all.
    //
    // Why the domain is stored as a plain string in cdk.json, not as a CDK
    // cross-stack export from ApiStack:
    //   CDK cross-stack references create a hard dependency edge in the graph:
    //     StorageStack → ApiStack (needs the API GW URL)
    //     ApiStack → StorageStack (needs the S3 bucket and DynamoDB table)
    //   That cycle causes 'cdk deploy' to refuse to synthesise with:
    //     "A dependency cycle was detected between stacks"
    //   Storing the hostname as a concrete string in cdk.json context
    //   (populated after the first 'deploy.sh api') breaks the cycle.
    //
    // CloudFront behavior config explained:
    //   - ALLOW_ALL methods: /api/presign (POST), /api/analyze (POST),
    //     /api/status/{id} (GET), /api/health (GET) all need to pass through.
    //   - CACHING_DISABLED: API responses are unique per request; caching
    //     would serve stale presigned URLs or stale job status to the browser.
    //   - ALL_VIEWER_EXCEPT_HOST_HEADER: Forward all headers (Authorization,
    //     Content-Type, etc.) except Host, which must be replaced by
    //     CloudFront with the API Gateway domain so APIGW accepts the request.
    //   - originPath = /v1: API Gateway stages are path-prefixed; without this
    //     /api/presign would hit /api/presign instead of /v1/api/presign.
    if (apiGatewayDomain) {
      this.distribution.addBehavior(
        '/api/*',
        new cfOrigins.HttpOrigin(apiGatewayDomain, {
          originPath:     `/${apiGatewayStageName}`,
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          httpsPort:      443,
        }),
        {
          viewerProtocolPolicy:  cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods:        cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy:           cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:   cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress:              false,
        },
      );
    }

    this.appUrl = appFqdn
      ? `https://${appFqdn}`
      : `https://${this.distribution.distributionDomainName}`;

    // ─── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UploadBucketName', { value: this.uploadBucket.bucketName, exportName: 'ColdbonesUploadBucket' });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: this.siteBucket.bucketName, exportName: 'ColdbonesSiteBucket' });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId, exportName: 'ColdbonesDistributionId' });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: this.distribution.distributionDomainName,
      description: 'Usable immediately for testing before DNS is switched',
      exportName: 'ColdbonesCloudfrontDomain',
    });
    new cdk.CfnOutput(this, 'AppUrl', { value: this.appUrl, exportName: 'ColdbonesAppUrl' });
    new cdk.CfnOutput(this, 'JobsTableName', { value: this.jobsTable.tableName, exportName: 'ColdbonesJobsTable' });
  }
}
