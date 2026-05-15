import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { OrchestrationStack } from '@infra/stacks/orchestration-stack';

function createTestStack(): { app: cdk.App; template: Template } {
  const app = new cdk.App();

  // Create a shared infrastructure stack to provide dependencies
  const sharedStack = new cdk.Stack(app, 'SharedStack');

  const encryptionKey = new kms.Key(sharedStack, 'TestKey');

  const denialAppealsTable = new dynamodb.Table(sharedStack, 'TestTable', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  });

  const ingestionBucket = new s3.Bucket(sharedStack, 'IngestionBucket');
  const documentsBucket = new s3.Bucket(sharedStack, 'DocumentsBucket');
  const appealLettersBucket = new s3.Bucket(sharedStack, 'AppealLettersBucket');

  const vpc = new ec2.Vpc(sharedStack, 'TestVpc', { maxAzs: 2 });

  const orchestrationStack = new OrchestrationStack(app, 'OrchestrationStack', {
    denialAppealsTable,
    ingestionBucket,
    documentsBucket,
    appealLettersBucket,
    encryptionKey,
    vpc,
  });

  const template = Template.fromStack(orchestrationStack);
  return { app, template };
}

/**
 * Extracts the state machine definition from the CloudFormation template.
 * The DefinitionString is a Fn::Join when it contains token references (Lambda ARNs),
 * so we need to resolve it by joining the parts with a placeholder.
 */
function extractStateMachineDefinition(template: Template): Record<string, unknown> {
  const resources = template.findResources('AWS::StepFunctions::StateMachine');
  const smResource = Object.values(resources)[0];
  const definitionString = smResource.Properties.DefinitionString;

  // If it's a Fn::Join, resolve it
  if (definitionString && typeof definitionString === 'object' && 'Fn::Join' in definitionString) {
    const [separator, parts] = definitionString['Fn::Join'];
    const resolved = parts
      .map((part: unknown) => (typeof part === 'string' ? part : 'PLACEHOLDER_ARN'))
      .join(separator);
    return JSON.parse(resolved);
  }

  // If it's already a string
  if (typeof definitionString === 'string') {
    return JSON.parse(definitionString);
  }

  throw new Error('Unable to extract state machine definition');
}

describe('OrchestrationStack', () => {
  describe('State Machine', () => {
    it('should create a Step Functions Standard state machine', () => {
      const { template } = createTestStack();

      template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'denial-appeal-pipeline',
        StateMachineType: 'STANDARD',
        TracingConfiguration: {
          Enabled: true,
        },
      });
    });

    it('should define sequential steps: ingest → classify → evidence → viability → generate', () => {
      const { template } = createTestStack();
      const definition = extractStateMachineDefinition(template);
      const states = definition.States as Record<string, Record<string, unknown>>;

      expect(states.IngestStep).toBeDefined();
      expect(states.IngestStep.Type).toBe('Task');
      expect(states.IngestStep.Next).toBe('ClassifyStep');

      expect(states.ClassifyStep).toBeDefined();
      expect(states.ClassifyStep.Type).toBe('Task');
      expect(states.ClassifyStep.Next).toBe('EvidenceStep');

      expect(states.EvidenceStep).toBeDefined();
      expect(states.EvidenceStep.Type).toBe('Task');
      expect(states.EvidenceStep.Next).toBe('ViabilityStep');

      expect(states.ViabilityStep).toBeDefined();
      expect(states.ViabilityStep.Type).toBe('Task');
      expect(states.ViabilityStep.Next).toBe('GenerateStep');

      expect(states.GenerateStep).toBeDefined();
      expect(states.GenerateStep.Type).toBe('Task');
      expect(states.GenerateStep.End).toBe(true);
    });

    it('should configure retry policies with 3 attempts and exponential backoff', () => {
      const { template } = createTestStack();
      const definition = extractStateMachineDefinition(template);
      const states = definition.States as Record<string, Record<string, unknown>>;

      // Check retry config on each step
      const stepNames = ['IngestStep', 'ClassifyStep', 'EvidenceStep', 'ViabilityStep', 'GenerateStep'];
      for (const stepName of stepNames) {
        const retryConfig = states[stepName].Retry as Array<Record<string, unknown>>;
        expect(retryConfig).toBeDefined();
        expect(retryConfig.length).toBeGreaterThan(0);

        // Find the retry entry that handles States.ALL (our custom retry)
        const customRetry = retryConfig.find(
          (r) => Array.isArray(r.ErrorEquals) && r.ErrorEquals.includes('States.ALL')
        );
        expect(customRetry, `${stepName} should have a States.ALL retry`).toBeDefined();
        expect(customRetry!.MaxAttempts).toBe(3);
        expect(customRetry!.IntervalSeconds).toBe(1);
        expect(customRetry!.BackoffRate).toBe(2);
        expect(customRetry!.MaxDelaySeconds).toBe(30);
      }
    });

    it('should configure 120 second timeout per step', () => {
      const { template } = createTestStack();
      const definition = extractStateMachineDefinition(template);
      const states = definition.States as Record<string, Record<string, unknown>>;

      const stepNames = ['IngestStep', 'ClassifyStep', 'EvidenceStep', 'ViabilityStep', 'GenerateStep'];
      for (const stepName of stepNames) {
        expect(states[stepName].TimeoutSeconds).toBe(120);
      }
    });

    it('should enable logging with ALL level', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        LoggingConfiguration: Match.objectLike({
          Level: 'ALL',
          IncludeExecutionData: true,
        }),
      });
    });
  });

  describe('Lambda Functions', () => {
    it('should create 5 Lambda functions for pipeline steps', () => {
      const { template } = createTestStack();

      template.resourceCountIs('AWS::Lambda::Function', 5);
    });

    it('should configure Lambda functions with Node.js 20 runtime', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        Architectures: ['arm64'],
      });
    });

    it('should configure Lambda functions with 120 second timeout', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 120,
      });
    });

    it('should configure Lambda functions in VPC', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Lambda::Function', {
        VpcConfig: Match.objectLike({
          SubnetIds: Match.anyValue(),
          SecurityGroupIds: Match.anyValue(),
        }),
      });
    });

    it('should enable X-Ray tracing on Lambda functions', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Lambda::Function', {
        TracingConfig: {
          Mode: 'Active',
        },
      });
    });
  });

  describe('CloudWatch Alarms', () => {
    it('should create a failure rate alarm with 5% threshold', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'denial-appeal-pipeline-failure-rate',
        Threshold: 5,
        EvaluationPeriods: 3,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
      });
    });

    it('should create an execution duration alarm with 5 minute threshold', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'denial-appeal-pipeline-duration',
        Threshold: 300000,
        EvaluationPeriods: 3,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
      });
    });
  });

  describe('EventBridge Rule', () => {
    it('should create an EventBridge rule for S3 object creation', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'denial-appeal-ingestion-trigger',
        EventPattern: Match.objectLike({
          source: ['aws.s3'],
          'detail-type': ['Object Created'],
        }),
      });
    });

    it('should target the state machine from the EventBridge rule', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.anyValue(),
            RoleArn: Match.anyValue(),
          }),
        ]),
      });
    });
  });

  describe('CloudWatch Dashboard', () => {
    it('should create a CloudWatch dashboard', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'denial-appeal-pipeline',
      });
    });
  });

  describe('Tags', () => {
    it('should tag all resources with Project=DenialAppealAgent', () => {
      const { template } = createTestStack();

      // Check that the state machine has the project tag
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        Tags: Match.arrayWith([
          Match.objectLike({
            Key: 'Project',
            Value: 'DenialAppealAgent',
          }),
        ]),
      });
    });
  });

  describe('Stack Outputs', () => {
    it('should output the state machine ARN', () => {
      const { template } = createTestStack();

      template.hasOutput('StateMachineArn', {
        Description: 'Step Functions state machine ARN for the denial appeal pipeline',
      });
    });

    it('should output the state machine name', () => {
      const { template } = createTestStack();

      template.hasOutput('StateMachineName', {
        Description: 'Step Functions state machine name',
      });
    });
  });
});
