import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface GpuAsgProps {
  vpc: ec2.IVpc;
  vpcSubnets?: ec2.SubnetSelection;
  launchTemplate: ec2.LaunchTemplate;
  minCapacity?: number;
  maxCapacity?: number;
  desiredCapacity?: number;
  /** If true use mixed-instance policy with Spot as primary */
  useSpot?: boolean;
  /** Additional on-demand instance types for mixed fleet */
  spotInstanceTypes?: ec2.InstanceType[];
  /** % of on-demand instances in mixed fleet (0–100) */
  onDemandPercentage?: number;
  /** ASG name prefix */
  namePrefix?: string;
  /** lifecycle hooks: LAUNCH and TERMINATE go here */
  lifecycleLambdaArn?: string;
}

export class GpuAsg extends Construct {
  public readonly asg: autoscaling.AutoScalingGroup;
  public readonly launchHook?: autoscaling.LifecycleHook;
  public readonly terminateHook?: autoscaling.LifecycleHook;

  constructor(scope: Construct, id: string, props: GpuAsgProps) {
    super(scope, id);

    const {
      useSpot = false,
      minCapacity = 0,
      maxCapacity = 1,
      desiredCapacity = 0,
      onDemandPercentage = useSpot ? 0 : 100,
      namePrefix = 'coldbones',
    } = props;

    if (useSpot && props.spotInstanceTypes && props.spotInstanceTypes.length > 0) {
      // Mixed instances with Spot
      this.asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
        vpc: props.vpc,
        vpcSubnets: props.vpcSubnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        mixedInstancesPolicy: {
          launchTemplate: props.launchTemplate,
          launchTemplateOverrides: [
            { instanceType: new ec2.InstanceType('g5.2xlarge') },
            ...props.spotInstanceTypes.map(t => ({ instanceType: t })),
          ],
          instancesDistribution: {
            onDemandPercentageAboveBaseCapacity: onDemandPercentage,
            spotAllocationStrategy:
              autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
            spotMaxPrice: '1.50', // g5.2xlarge on-demand ~$1.21/hr — cap at $1.50
          },
        },
        minCapacity,
        maxCapacity,
        desiredCapacity,
        healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(15) }),
        updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
        defaultInstanceWarmup: cdk.Duration.minutes(10),
        terminationPolicies: [autoscaling.TerminationPolicy.OLDEST_INSTANCE],
      });
    } else {
      // On-demand only
      this.asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
        vpc: props.vpc,
        vpcSubnets: props.vpcSubnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        launchTemplate: props.launchTemplate,
        minCapacity,
        maxCapacity,
        desiredCapacity,
        healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(15) }),
        updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
        defaultInstanceWarmup: cdk.Duration.minutes(5),
        terminationPolicies: [autoscaling.TerminationPolicy.OLDEST_INSTANCE],
      });
    }

    cdk.Tags.of(this.asg).add('Name', `${namePrefix}-gpu${useSpot ? '-spot' : ''}`);

    // CloudWatch alarms
    new cloudwatch.Alarm(this, 'CpuHigh', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: { AutoScalingGroupName: this.asg.autoScalingGroupName },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 90,
      evaluationPeriods: 3,
      alarmDescription: `${namePrefix} GPU ASG CPU >90% for 15 min`,
    });

    new cloudwatch.Alarm(this, 'CapacityZero', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AutoScaling',
        metricName: 'GroupInServiceInstances',
        dimensionsMap: { AutoScalingGroupName: this.asg.autoScalingGroupName },
        period: cdk.Duration.minutes(1),
        statistic: 'Minimum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `${namePrefix} GPU ASG has no in-service instances`,
    });
  }
}
