import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class RuntimeStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly gpuSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private-isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Security group for V2 Lambda functions',
    });

    this.gpuSecurityGroup = new ec2.SecurityGroup(this, 'GpuSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Security group for V2 GPU runtime',
    });

    this.gpuSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(8000),
      'Allow Lambda access to vLLM port',
    );

    const gpuIpParam = new ssm.StringParameter(this, 'GpuIpParam', {
      parameterName: '/coldbones/v2/gpu-ip',
      stringValue: 'not-yet-assigned',
    });

    const gpuPortParam = new ssm.StringParameter(this, 'GpuPortParam', {
      parameterName: '/coldbones/v2/gpu-port',
      stringValue: '8000',
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'GpuIpParamName', { value: gpuIpParam.parameterName });
    new cdk.CfnOutput(this, 'GpuPortParamName', { value: gpuPortParam.parameterName });
  }
}
