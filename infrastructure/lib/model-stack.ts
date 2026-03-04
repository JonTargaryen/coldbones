import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ModelLaunchTemplate } from '../constructs/model-launch-template';
import { GpuAsg } from '../constructs/gpu-asg';

export interface ModelStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  gpuSecurityGroup: ec2.ISecurityGroup;
  modelBucket?: s3.IBucket;
  openaiKeyParamName?: string;
  instanceType?: ec2.InstanceType;
  modelQuant?: string;
}

/**
 * On-demand GPU ASG for fast-mode inference.
 * Stays running 24/7 (min=1), no spot interruptions.
 */
export class ModelStack extends cdk.Stack {
  public readonly asgName: string;
  public readonly instanceRole: iam.Role;
  public readonly endpoint: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: ModelStackProps) {
    super(scope, id, props);

    const instanceType =
      props.instanceType ?? new ec2.InstanceType('g5.2xlarge');

    // ─── IAM Role ─────────────────────────────────────────────────────────
    this.instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    if (props.modelBucket) {
      props.modelBucket.grantRead(this.instanceRole);
    }

    if (props.openaiKeyParamName) {
      this.instanceRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter${props.openaiKeyParamName}`,
          ],
        }),
      );
    }

    // Allow lifecycle hook completion
    this.instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'autoscaling:CompleteLifecycleAction',
          'autoscaling:RecordLifecycleActionHeartbeat',
        ],
        resources: ['*'],
      }),
    );

    // ─── Launch Template ───────────────────────────────────────────────────
    const lt = new ModelLaunchTemplate(this, 'LT', {
      vpc: props.vpc,
      securityGroup: props.gpuSecurityGroup,
      instanceRole: this.instanceRole,
      instanceType,
      modelQuant: props.modelQuant,
      openaiKeyParam: props.openaiKeyParamName,
      modelBucket: props.modelBucket?.bucketName,
    });

    // ─── ASG (on-demand, always-on) ────────────────────────────────────────
    const asg = new GpuAsg(this, 'GpuAsg', {
      vpc: props.vpc,
      launchTemplate: lt.launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      useSpot: false,
      namePrefix: 'coldbones-fast',
    });

    this.asgName = asg.asg.autoScalingGroupName;

    // Store ASG name in SSM for Lambda to read
    this.endpoint = new ssm.StringParameter(this, 'FastAsgParam', {
      parameterName: '/coldbones/fast-asg-name',
      stringValue: asg.asg.autoScalingGroupName,
      description: 'Fast-mode on-demand GPU ASG name',
    });

    new cdk.CfnOutput(this, 'FastAsgName', {
      value: this.asgName,
      exportName: 'ColdbonesGpuFastAsg',
    });
  }
}
