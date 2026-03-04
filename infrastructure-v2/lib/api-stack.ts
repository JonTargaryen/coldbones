import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const healthFn = new lambda.Function(this, 'HealthFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      status: "ok",
      service: "coldbones-v2",
      timestamp: new Date().toISOString()
    })
  };
};
`),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });

    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'Coldbones V2 API',
      deployOptions: {
        stageName: 'v2',
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });

    api.root.addResource('health').addMethod('GET', new apigw.LambdaIntegration(healthFn));

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}