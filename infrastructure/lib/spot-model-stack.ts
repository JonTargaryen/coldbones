import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';
import { ModelLaunchTemplate } from '../constructs/model-launch-template';
import { GpuAsg } from '../constructs/gpu-asg';

export interface SpotModelStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  gpuSecurityGroup: ec2.ISecurityGroup;
  notificationTopic: sns.ITopic;
  modelBucket?: s3.IBucket;
  openaiKeyParamName?: string;
  /** Instance types for mixed fleet, in preference order */
  instanceTypes?: ec2.InstanceType[];
  modelQuant?: string;
}

/**
 * Spot-instance GPU ASG for slow-mode batch inference.
 * Scale 0→1 on queue depth; handles interruptions gracefully.
 */
export class SpotModelStack extends cdk.Stack {
  public readonly asgName: string;
  public readonly instanceRole: iam.Role;

  constructor(scope: Construct, id: string, props: SpotModelStackProps) {
    super(scope, id, props);

    const instanceTypes = props.instanceTypes ?? [
      new ec2.InstanceType('g5.2xlarge'),
      new ec2.InstanceType('g4dn.2xlarge'),
      new ec2.InstanceType('g4ad.2xlarge'),
    ];

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

    // SNS publish (for spot-interrupt notification)
    props.notificationTopic.grantPublish(this.instanceRole);

    // SQS read/delete (re-enqueue interrupted jobs)
    this.instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:SendMessage',
          'sqs:GetQueueUrl',
        ],
        resources: ['*'],
      }),
    );

    // Lifecycle hook
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
    const [primaryType, ...remainingTypes] = instanceTypes;
    const lt = new ModelLaunchTemplate(this, 'LT', {
      vpc: props.vpc,
      securityGroup: props.gpuSecurityGroup,
      instanceRole: this.instanceRole,
      instanceType: primaryType,
      modelQuant: props.modelQuant,
      openaiKeyParam: props.openaiKeyParamName,
      modelBucket: props.modelBucket?.bucketName,
    });

    // ─── Spot ASG (scale 0→1) ──────────────────────────────────────────────
    const asg = new GpuAsg(this, 'SpotAsg', {
      vpc: props.vpc,
      launchTemplate: lt.launchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 0,
      useSpot: true,
      spotInstanceTypes: remainingTypes,
      onDemandPercentage: 0,
      namePrefix: 'coldbones-slow',
    });

    this.asgName = asg.asg.autoScalingGroupName;

    // ─── Lifecycle Hook: TERMINATING ──────────────────────────────────────
    // Lambda lifecycle_manager will drain in-flight job before termination
    new autoscaling.LifecycleHook(this, 'TerminateHook', {
      autoScalingGroup: asg.asg,
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      heartbeatTimeout: cdk.Duration.minutes(5),
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      notificationTarget: new cdk.aws_autoscaling_hooktargets.TopicHook(
        props.notificationTopic,
      ),
      lifecycleHookName: 'coldbones-spot-terminate',
    });

    // ─── Lifecycle Hook: LAUNCHING ────────────────────────────────────────
    // Lambda lifecycle_manager waits for llama-server health check
    new autoscaling.LifecycleHook(this, 'LaunchHook', {
      autoScalingGroup: asg.asg,
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_LAUNCHING,
      heartbeatTimeout: cdk.Duration.minutes(20),
      defaultResult: autoscaling.DefaultResult.ABANDON,
      notificationTarget: new cdk.aws_autoscaling_hooktargets.TopicHook(
        props.notificationTopic,
      ),
      lifecycleHookName: 'coldbones-spot-launch',
    });

    // Store ASG name in SSM
    new ssm.StringParameter(this, 'SlowAsgParam', {
      parameterName: '/coldbones/slow-asg-name',
      stringValue: asg.asg.autoScalingGroupName,
      description: 'Slow-mode spot GPU ASG name',
    });

    new cdk.CfnOutput(this, 'SlowAsgName', {
      value: this.asgName,
      exportName: 'ColdbonesGpuSlowAsg',
    });
  }
}
