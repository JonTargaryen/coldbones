/**
 * ColdbonesNetwork — VPC, subnets, security groups, VPC endpoints.
 *
 * Lambdas run in this VPC so they can reach the GPU instance on its
 * private IP (port 8000 for vLLM) without leaving AWS.
 * VPC endpoints eliminate NAT-Gateway charges for all AWS APIs.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  /** Attached to the GPU EC2 instance. */
  public readonly gpuSecurityGroup: ec2.SecurityGroup;
  /** Attached to all Lambda functions. */
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── VPC ──────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'ColdbonesVpc', {
      maxAzs: 2,
      natGateways: 1,     // GPU model download (HuggingFace) needs egress
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public',  subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    // ─── VPC Endpoints (zero-cost AWS API access from private subnet) ─────
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
    this.vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.vpc.addInterfaceEndpoint('SqsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SQS,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.vpc.addInterfaceEndpoint('LambdaEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.vpc.addInterfaceEndpoint('Ec2Endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.vpc.addInterfaceEndpoint('AutoscalingEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.AUTOSCALING,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ─── Security Groups ──────────────────────────────────────────────────
    this.gpuSecurityGroup = new ec2.SecurityGroup(this, 'GpuSg', {
      vpc: this.vpc,
      description: 'Coldbones GPU (vLLM) instance',
      allowAllOutbound: true,
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Coldbones Lambda functions',
      allowAllOutbound: true,
    });

    // Lambda → GPU on port 8000 (vLLM default)
    this.gpuSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(8000),
      'Lambda to vLLM API',
    );

    // SSH / SSM from within VPC
    this.gpuSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(22),
      'SSH from within VPC',
    );

    // ─── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: 'ColdbonesVpcId',
    });
    new cdk.CfnOutput(this, 'GpuSgId', {
      value: this.gpuSecurityGroup.securityGroupId,
      exportName: 'ColdbonesGpuSgId',
    });
    new cdk.CfnOutput(this, 'LambdaSgId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      exportName: 'ColdbonesLambdaSgId',
    });
  }
}
