import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cfOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
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
}

export class StorageStack extends cdk.Stack {
  public readonly uploadBucket: s3.Bucket;
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly jobsTable: dynamodb.Table;
  public readonly hostedZone?: route53.HostedZone;
  public readonly certificate?: acm.Certificate;
  /** https://app.omlahiri.com  OR  https://xxxx.cloudfront.net */
  public readonly appUrl: string;

  constructor(scope: Construct, id: string, props: StorageStackProps = {}) {
    super(scope, id, props);

    const { domainName, appSubdomain = 'app' } = props;
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

    // ─── S3: Upload Bucket ─────────────────────────────────────────────────
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
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
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
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(0) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
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
      pointInTimeRecovery: false,
    });

    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'userId-createdAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

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
