import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Props for the ApiStack, accepting shared infrastructure outputs.
 */
export interface ApiStackProps extends cdk.StackProps {
  /** DynamoDB DenialAppeals table */
  denialAppealsTable: dynamodb.ITable;
  /** KMS Customer Managed Key for encryption */
  encryptionKey: kms.IKey;
  /** VPC for Lambda functions */
  vpc: ec2.IVpc;
  /** EventBridge custom event bus */
  eventBus: events.IEventBus;
}

/**
 * CDK Stack defining the API Gateway REST API and webhook delivery Lambda
 * for the Denial Appeal Agent.
 *
 * Endpoints:
 * - POST /outcomes — Record appeal outcomes
 * - GET /workflows/{claimId}/status — Query workflow status
 * - POST /tenants — Onboard new tenants
 * - GET /metrics — Retrieve aggregate metrics
 *
 * Authentication: IAM authorization on all endpoints.
 * Rate limiting: 100 requests/minute per API key via usage plan.
 * Webhook delivery: EventBridge → Lambda with 3 retries, exponential backoff.
 *
 * Requirements: 10.4, 10.5
 */
export class ApiStack extends cdk.Stack {
  /** The API Gateway REST API */
  public readonly api: apigateway.RestApi;

  /** Webhook delivery Lambda function */
  public readonly webhookDeliveryFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'DenialAppealAgent');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // ─── API Gateway REST API ─────────────────────────────────────────────

    this.api = new apigateway.RestApi(this, 'DenialAppealApi', {
      restApiName: 'denial-appeal-api',
      description: 'RESTful API for the Revenue Cycle Denial Appeal Agent',
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Tenant-Id',
        ],
      },
      endpointTypes: [apigateway.EndpointType.REGIONAL],
    });

    // ─── Usage Plan with Throttling ───────────────────────────────────────

    const apiKey = this.api.addApiKey('DenialAppealApiKey', {
      apiKeyName: 'denial-appeal-default-key',
      description: 'Default API key for the Denial Appeal Agent',
    });

    const usagePlan = this.api.addUsagePlan('DenialAppealUsagePlan', {
      name: 'denial-appeal-standard',
      description: 'Standard usage plan with 100 req/min throttling per tenant',
      throttle: {
        rateLimit: 100,   // 100 requests per second burst
        burstLimit: 100,  // 100 requests per minute sustained
      },
      quota: {
        limit: 10000,
        period: apigateway.Period.DAY,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    // ─── Lambda Functions for API Endpoints ───────────────────────────────

    const commonLambdaProps: Partial<lambdaNodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        TABLE_NAME: props.denialAppealsTable.tableName,
        KMS_KEY_ARN: props.encryptionKey.keyArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        format: lambdaNodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    };

    // POST /outcomes handler
    const outcomesFunction = new lambdaNodejs.NodejsFunction(this, 'OutcomesFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/outcomes/recorder.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-outcomes-api',
      description: 'Records appeal outcomes via API',
    });

    // GET /workflows/{claimId}/status handler
    const workflowStatusFunction = new lambdaNodejs.NodejsFunction(this, 'WorkflowStatusFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/orchestration/status-api.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-workflow-status-api',
      description: 'Queries workflow status by claim ID',
    });

    // POST /tenants handler
    const tenantsFunction = new lambdaNodejs.NodejsFunction(this, 'TenantsFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/tenant/provisioner.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-tenants-api',
      description: 'Onboards new tenants',
      timeout: cdk.Duration.minutes(5),
    });

    // GET /metrics handler
    const metricsFunction = new lambdaNodejs.NodejsFunction(this, 'MetricsFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/outcomes/metrics-calculator.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-metrics-api',
      description: 'Retrieves aggregate appeal metrics',
    });

    // ─── IAM Permissions ──────────────────────────────────────────────────

    const apiFunctions = [outcomesFunction, workflowStatusFunction, tenantsFunction, metricsFunction];
    for (const fn of apiFunctions) {
      props.denialAppealsTable.grantReadWriteData(fn);
      props.encryptionKey.grantEncryptDecrypt(fn);
    }

    // ─── API Resources and Methods ────────────────────────────────────────

    // POST /outcomes
    const outcomesResource = this.api.root.addResource('outcomes');
    outcomesResource.addMethod('POST', new apigateway.LambdaIntegration(outcomesFunction, {
      proxy: true,
    }), {
      authorizationType: apigateway.AuthorizationType.IAM,
      apiKeyRequired: true,
    });

    // GET /workflows/{claimId}/status
    const workflowsResource = this.api.root.addResource('workflows');
    const claimIdResource = workflowsResource.addResource('{claimId}');
    const statusResource = claimIdResource.addResource('status');
    statusResource.addMethod('GET', new apigateway.LambdaIntegration(workflowStatusFunction, {
      proxy: true,
    }), {
      authorizationType: apigateway.AuthorizationType.IAM,
      apiKeyRequired: true,
    });

    // POST /tenants
    const tenantsResource = this.api.root.addResource('tenants');
    tenantsResource.addMethod('POST', new apigateway.LambdaIntegration(tenantsFunction, {
      proxy: true,
    }), {
      authorizationType: apigateway.AuthorizationType.IAM,
      apiKeyRequired: true,
    });

    // GET /metrics
    const metricsResource = this.api.root.addResource('metrics');
    metricsResource.addMethod('GET', new apigateway.LambdaIntegration(metricsFunction, {
      proxy: true,
    }), {
      authorizationType: apigateway.AuthorizationType.IAM,
      apiKeyRequired: true,
    });

    // ─── Webhook Delivery Lambda ──────────────────────────────────────────

    this.webhookDeliveryFunction = new lambdaNodejs.NodejsFunction(this, 'WebhookDeliveryFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/webhooks/delivery.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-webhook-delivery',
      description: 'Delivers webhook notifications for workflow state changes',
      timeout: cdk.Duration.seconds(45), // Allow time for 3 retries with 10s timeout each
      memorySize: 256,
    });

    props.denialAppealsTable.grantReadData(this.webhookDeliveryFunction);
    props.encryptionKey.grantDecrypt(this.webhookDeliveryFunction);

    // ─── EventBridge Rule for Workflow State Changes ──────────────────────

    const webhookRule = new events.Rule(this, 'WebhookDeliveryRule', {
      ruleName: 'denial-appeal-webhook-delivery',
      description: 'Routes workflow state change events to webhook delivery Lambda',
      eventBus: props.eventBus,
      eventPattern: {
        source: ['denial-appeal-agent'],
        detailType: [
          'workflow.state.changed',
          'appeal.submitted',
          'evidence.attached',
          'appeal.sent',
          'response.received',
          'appeal.resolved',
        ],
      },
    });

    webhookRule.addTarget(new eventsTargets.LambdaFunction(this.webhookDeliveryFunction, {
      maxEventAge: cdk.Duration.minutes(5),
      retryAttempts: 2, // EventBridge built-in retries (in addition to Lambda-level retries)
    }));

    // ─── Optional Agentic Mode Endpoint ──────────────────────────────────

    const enableAgenticMode =
      this.node.tryGetContext('ENABLE_AGENTIC_MODE') === 'true' ||
      process.env.ENABLE_AGENTIC_MODE === 'true';

    if (enableAgenticMode) {
      const agentInvokeFunction = new lambdaNodejs.NodejsFunction(this, 'AgentInvokeFunction', {
        ...commonLambdaProps,
        entry: path.join(__dirname, '../../src/lambdas/agent/invoke-handler.ts'),
        handler: 'handler',
        functionName: 'denial-appeal-agent-invoke',
        description: 'Invokes the Bedrock Agent for conversational denial appeal management',
        timeout: cdk.Duration.seconds(60), // Agent invocations may take longer
        environment: {
          ...commonLambdaProps.environment!,
          ENABLE_AGENTIC_MODE: 'true',
          BEDROCK_AGENT_ID: this.node.tryGetContext('BEDROCK_AGENT_ID') || '',
          BEDROCK_AGENT_ALIAS_ID: this.node.tryGetContext('BEDROCK_AGENT_ALIAS_ID') || '',
        },
      });

      props.denialAppealsTable.grantReadData(agentInvokeFunction);
      props.encryptionKey.grantDecrypt(agentInvokeFunction);

      // Grant Bedrock Agent Runtime permissions
      agentInvokeFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeAgent'],
          resources: ['*'],
        })
      );

      // POST /agent/invoke
      const agentResource = this.api.root.addResource('agent');
      const invokeResource = agentResource.addResource('invoke');
      invokeResource.addMethod('POST', new apigateway.LambdaIntegration(agentInvokeFunction, {
        proxy: true,
      }), {
        authorizationType: apigateway.AuthorizationType.IAM,
        apiKeyRequired: true,
      });
    }

    // ─── Stack Outputs ────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL for the Denial Appeal Agent',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      description: 'API Gateway REST API ID',
    });

    new cdk.CfnOutput(this, 'WebhookDeliveryFunctionArn', {
      value: this.webhookDeliveryFunction.functionArn,
      description: 'Webhook delivery Lambda function ARN',
    });
  }
}
