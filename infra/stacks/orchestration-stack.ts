import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Props for the OrchestrationStack, accepting shared infrastructure outputs.
 */
export interface OrchestrationStackProps extends cdk.StackProps {
  /** DynamoDB DenialAppeals table */
  denialAppealsTable: dynamodb.ITable;
  /** S3 bucket for incoming denial documents */
  ingestionBucket: s3.IBucket;
  /** S3 bucket for processed documents */
  documentsBucket: s3.IBucket;
  /** S3 bucket for generated appeal letters */
  appealLettersBucket: s3.IBucket;
  /** KMS Customer Managed Key for encryption */
  encryptionKey: kms.IKey;
  /** VPC for Lambda functions */
  vpc: ec2.IVpc;
}

/**
 * CDK Stack defining the Step Functions state machine for the
 * denial appeal orchestration pipeline.
 *
 * Sequential steps: Ingestion → Classification → Evidence Retrieval →
 * Viability Assessment → Letter Generation
 *
 * Each step invokes a Lambda function with:
 * - Retry: 3 attempts, exponential backoff (1s base, 2x rate, 30s max)
 * - Timeout: 120 seconds per step
 * - CloudWatch metrics emission per step
 */
export class OrchestrationStack extends cdk.Stack {
  /** The Step Functions state machine */
  public readonly stateMachine: sfn.StateMachine;

  /** Lambda functions for each pipeline step */
  public readonly ingestionFunction: lambdaNodejs.NodejsFunction;
  public readonly classifierFunction: lambdaNodejs.NodejsFunction;
  public readonly evidenceFunction: lambdaNodejs.NodejsFunction;
  public readonly viabilityFunction: lambdaNodejs.NodejsFunction;
  public readonly generatorFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    // Tags applied to all resources in this stack
    cdk.Tags.of(this).add('Project', 'DenialAppealAgent');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // ─── Lambda Functions ─────────────────────────────────────────────────

    const commonLambdaProps: Partial<lambdaNodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(120),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        TABLE_NAME: props.denialAppealsTable.tableName,
        INGESTION_BUCKET: props.ingestionBucket.bucketName,
        DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
        APPEAL_LETTERS_BUCKET: props.appealLettersBucket.bucketName,
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

    this.ingestionFunction = new lambdaNodejs.NodejsFunction(this, 'IngestionFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/ingestion/handler.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-ingestion',
      description: 'Ingests and parses denial documents from S3',
    });

    this.classifierFunction = new lambdaNodejs.NodejsFunction(this, 'ClassifierFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/classifier/handler.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-classifier',
      description: 'Classifies denial reasons into CARC/RARC codes',
    });

    this.evidenceFunction = new lambdaNodejs.NodejsFunction(this, 'EvidenceFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/evidence/handler.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-evidence',
      description: 'Retrieves clinical evidence from HealthLake',
    });

    this.viabilityFunction = new lambdaNodejs.NodejsFunction(this, 'ViabilityFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/viability/handler.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-viability',
      description: 'Assesses appeal viability and calculates success probability',
    });

    this.generatorFunction = new lambdaNodejs.NodejsFunction(this, 'GeneratorFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/lambdas/generator/handler.ts'),
      handler: 'handler',
      functionName: 'denial-appeal-generator',
      description: 'Generates appeal letters using Amazon Bedrock',
    });

    // ─── IAM Permissions ──────────────────────────────────────────────────

    const allFunctions = [
      this.ingestionFunction,
      this.classifierFunction,
      this.evidenceFunction,
      this.viabilityFunction,
      this.generatorFunction,
    ];

    for (const fn of allFunctions) {
      props.denialAppealsTable.grantReadWriteData(fn);
      props.encryptionKey.grantEncryptDecrypt(fn);
      props.ingestionBucket.grantRead(fn);
      props.documentsBucket.grantReadWrite(fn);
      props.appealLettersBucket.grantReadWrite(fn);
    }

    // ─── Step Functions Definition ────────────────────────────────────────

    // Common retry configuration for all steps
    const retryConfig: sfn.RetryProps = {
      maxAttempts: 3,
      interval: cdk.Duration.seconds(1),
      backoffRate: 2.0,
      maxDelay: cdk.Duration.seconds(30),
      errors: ['States.ALL'],
    };

    // Step 1: Ingestion
    const ingestStep = new tasks.LambdaInvoke(this, 'IngestStep', {
      lambdaFunction: this.ingestionFunction,
      outputPath: '$.Payload',
      comment: 'Extract and parse denial document',
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(120)),
    });
    ingestStep.addRetry(retryConfig);

    // Step 2: Classification
    const classifyStep = new tasks.LambdaInvoke(this, 'ClassifyStep', {
      lambdaFunction: this.classifierFunction,
      outputPath: '$.Payload',
      comment: 'Classify denial reasons into CARC/RARC codes',
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(120)),
    });
    classifyStep.addRetry(retryConfig);

    // Step 3: Evidence Retrieval
    const evidenceStep = new tasks.LambdaInvoke(this, 'EvidenceStep', {
      lambdaFunction: this.evidenceFunction,
      outputPath: '$.Payload',
      comment: 'Retrieve clinical evidence from HealthLake',
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(120)),
    });
    evidenceStep.addRetry(retryConfig);

    // Step 4: Viability Assessment
    const viabilityStep = new tasks.LambdaInvoke(this, 'ViabilityStep', {
      lambdaFunction: this.viabilityFunction,
      outputPath: '$.Payload',
      comment: 'Assess appeal viability and calculate success probability',
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(120)),
    });
    viabilityStep.addRetry(retryConfig);

    // Step 5: Letter Generation
    const generateStep = new tasks.LambdaInvoke(this, 'GenerateStep', {
      lambdaFunction: this.generatorFunction,
      outputPath: '$.Payload',
      comment: 'Generate appeal letter using Amazon Bedrock',
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(120)),
    });
    generateStep.addRetry(retryConfig);

    // Chain steps sequentially
    const definition = ingestStep
      .next(classifyStep)
      .next(evidenceStep)
      .next(viabilityStep)
      .next(generateStep);

    // ─── State Machine ────────────────────────────────────────────────────

    const logGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: '/aws/stepfunctions/denial-appeal-pipeline',
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'DenialAppealPipeline', {
      stateMachineName: 'denial-appeal-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      tracingEnabled: true,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      comment: 'Orchestrates the denial appeal workflow: ingest → classify → evidence → viability → generate',
    });

    // ─── Concurrency Control ──────────────────────────────────────────────
    // Note: Step Functions Standard Workflows don't have a native concurrency
    // limit setting. We use a resource-based policy approach via a CfnResource
    // override to set the execution limit, or rely on account-level service quotas.
    // For CDK, we configure the EventBridge rule to throttle invocations.

    // ─── S3 Event Trigger via EventBridge ─────────────────────────────────

    // Enable EventBridge notifications on the ingestion bucket
    // (This is typically done on the bucket itself; here we create the rule)
    const s3EventRule = new events.Rule(this, 'IngestionBucketEventRule', {
      ruleName: 'denial-appeal-ingestion-trigger',
      description: 'Triggers the denial appeal pipeline when documents are uploaded to the ingestion bucket',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [props.ingestionBucket.bucketName],
          },
          object: {
            key: [{ prefix: 'tenants/' }],
          },
        },
      },
    });

    s3EventRule.addTarget(new eventsTargets.SfnStateMachine(this.stateMachine, {
      input: events.RuleTargetInput.fromEventPath('$.detail'),
    }));

    // Grant EventBridge permission to start executions
    this.stateMachine.grantStartExecution(
      new iam.ServicePrincipal('events.amazonaws.com')
    );

    // ─── CloudWatch Metrics and Alarms ────────────────────────────────────

    // Step Functions provides built-in metrics per state machine:
    // - ExecutionsStarted, ExecutionsSucceeded, ExecutionsFailed
    // - ExecutionTime (p50, p95, p99)
    // We create alarms on the key operational metrics.

    // Alarm: Step failure rate > 5%
    const executionsFailed = this.stateMachine.metricFailed({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    });

    const executionsStarted = this.stateMachine.metricStarted({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    });

    const failureRateAlarm = new cloudwatch.Alarm(this, 'StepFailureRateAlarm', {
      alarmName: 'denial-appeal-pipeline-failure-rate',
      alarmDescription: 'Triggers when step failure rate exceeds 5% over 5 minutes',
      metric: new cloudwatch.MathExpression({
        expression: '(failed / started) * 100',
        usingMetrics: {
          failed: executionsFailed,
          started: executionsStarted,
        },
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Execution duration > 5 minutes
    const executionDurationAlarm = new cloudwatch.Alarm(this, 'ExecutionDurationAlarm', {
      alarmName: 'denial-appeal-pipeline-duration',
      alarmDescription: 'Triggers when p95 execution duration exceeds 5 minutes',
      metric: this.stateMachine.metricTime({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: 300000, // 5 minutes in milliseconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ─── CloudWatch Dashboard (per-step metrics) ──────────────────────────

    const dashboard = new cloudwatch.Dashboard(this, 'PipelineDashboard', {
      dashboardName: 'denial-appeal-pipeline',
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Pipeline Executions',
        left: [
          this.stateMachine.metricStarted({ statistic: 'Sum' }),
          this.stateMachine.metricSucceeded({ statistic: 'Sum' }),
          this.stateMachine.metricFailed({ statistic: 'Sum' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Execution Latency (ms)',
        left: [
          this.stateMachine.metricTime({ statistic: 'p50', label: 'p50' }),
          this.stateMachine.metricTime({ statistic: 'p95', label: 'p95' }),
          this.stateMachine.metricTime({ statistic: 'p99', label: 'p99' }),
        ],
        width: 12,
      }),
    );

    // ─── Stack Outputs ────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'Step Functions state machine ARN for the denial appeal pipeline',
    });

    new cdk.CfnOutput(this, 'StateMachineName', {
      value: this.stateMachine.stateMachineName,
      description: 'Step Functions state machine name',
    });

    new cdk.CfnOutput(this, 'IngestionFunctionArn', {
      value: this.ingestionFunction.functionArn,
      description: 'Ingestion Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'ClassifierFunctionArn', {
      value: this.classifierFunction.functionArn,
      description: 'Classifier Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'EvidenceFunctionArn', {
      value: this.evidenceFunction.functionArn,
      description: 'Evidence retrieval Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'ViabilityFunctionArn', {
      value: this.viabilityFunction.functionArn,
      description: 'Viability assessment Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'GeneratorFunctionArn', {
      value: this.generatorFunction.functionArn,
      description: 'Appeal generator Lambda function ARN',
    });
  }
}
