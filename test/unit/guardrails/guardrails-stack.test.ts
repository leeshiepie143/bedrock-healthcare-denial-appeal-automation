import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GuardrailsStack } from '@infra/stacks/guardrails-stack';

function createTestStack(): { app: cdk.App; template: Template; stack: GuardrailsStack } {
  const app = new cdk.App();
  const stack = new GuardrailsStack(app, 'GuardrailsStack');
  const template = Template.fromStack(stack);
  return { app, template, stack };
}

describe('GuardrailsStack', () => {
  describe('Guardrail Resource', () => {
    it('should create a Bedrock Guardrail', () => {
      const { template } = createTestStack();

      template.resourceCountIs('AWS::Bedrock::Guardrail', 1);
    });

    it('should configure the guardrail with correct name and description', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        Name: 'denial-appeal-agent-guardrail',
        Description: Match.stringLikeRegexp('Content safety guardrail'),
      });
    });

    it('should configure blocked input and output messaging', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        BlockedInputMessaging: Match.stringLikeRegexp('cannot be processed'),
        BlockedOutputsMessaging: Match.stringLikeRegexp('blocked due to content safety'),
      });
    });
  });

  describe('Content Policy', () => {
    it('should configure content filters for hate, violence, sexual, and misconduct at HIGH threshold', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        ContentPolicyConfig: {
          FiltersConfig: Match.arrayWith([
            Match.objectLike({ Type: 'HATE', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
            Match.objectLike({ Type: 'VIOLENCE', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
            Match.objectLike({ Type: 'SEXUAL', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
            Match.objectLike({ Type: 'MISCONDUCT', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
          ]),
        },
      });
    });

    it('should have exactly 4 content filters', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        ContentPolicyConfig: {
          FiltersConfig: Match.arrayEquals([
            Match.objectLike({ Type: 'HATE' }),
            Match.objectLike({ Type: 'VIOLENCE' }),
            Match.objectLike({ Type: 'SEXUAL' }),
            Match.objectLike({ Type: 'MISCONDUCT' }),
          ]),
        },
      });
    });
  });

  describe('Topic Policy', () => {
    it('should deny financial advice topic', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        TopicPolicyConfig: {
          TopicsConfig: Match.arrayWith([
            Match.objectLike({
              Name: 'financial-advice',
              Type: 'DENY',
              Definition: Match.stringLikeRegexp('financial advice'),
            }),
          ]),
        },
      });
    });

    it('should deny legal opinions topic', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        TopicPolicyConfig: {
          TopicsConfig: Match.arrayWith([
            Match.objectLike({
              Name: 'legal-opinions',
              Type: 'DENY',
              Definition: Match.stringLikeRegexp('legal opinion'),
            }),
          ]),
        },
      });
    });

    it('should deny treatment recommendations topic', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        TopicPolicyConfig: {
          TopicsConfig: Match.arrayWith([
            Match.objectLike({
              Name: 'treatment-recommendations',
              Type: 'DENY',
              Definition: Match.stringLikeRegexp('medical treatments'),
            }),
          ]),
        },
      });
    });

    it('should include examples for each denied topic', () => {
      const { template } = createTestStack();

      // Verify each denied topic has examples by checking the synthesized template directly
      const resources = template.findResources('AWS::Bedrock::Guardrail');
      const guardrailResource = Object.values(resources)[0];
      const topicsConfig = guardrailResource.Properties.TopicPolicyConfig.TopicsConfig as Array<{
        Name: string;
        Examples?: string[];
      }>;

      const financialTopic = topicsConfig.find((t) => t.Name === 'financial-advice');
      expect(financialTopic?.Examples).toBeDefined();
      expect(financialTopic!.Examples!.length).toBeGreaterThan(0);

      const legalTopic = topicsConfig.find((t) => t.Name === 'legal-opinions');
      expect(legalTopic?.Examples).toBeDefined();
      expect(legalTopic!.Examples!.length).toBeGreaterThan(0);

      const treatmentTopic = topicsConfig.find((t) => t.Name === 'treatment-recommendations');
      expect(treatmentTopic?.Examples).toBeDefined();
      expect(treatmentTopic!.Examples!.length).toBeGreaterThan(0);
    });
  });

  describe('Word Policy', () => {
    it('should enable managed profanity word list', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        WordPolicyConfig: {
          ManagedWordListsConfig: Match.arrayWith([
            Match.objectLike({ Type: 'PROFANITY' }),
          ]),
        },
      });
    });

    it('should block competitor names: Waystar, AKASA, CombineHealth', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        WordPolicyConfig: {
          WordsConfig: Match.arrayWith([
            Match.objectLike({ Text: 'Waystar' }),
            Match.objectLike({ Text: 'AKASA' }),
            Match.objectLike({ Text: 'CombineHealth' }),
          ]),
        },
      });
    });
  });

  describe('Sensitive Information Policy', () => {
    it('should ANONYMIZE (mask) SSN in outputs', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        SensitiveInformationPolicyConfig: {
          PiiEntitiesConfig: Match.arrayWith([
            Match.objectLike({
              Type: 'US_SOCIAL_SECURITY_NUMBER',
              Action: 'ANONYMIZE',
            }),
          ]),
        },
      });
    });

    it('should ANONYMIZE (mask) credit card numbers in outputs', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        SensitiveInformationPolicyConfig: {
          PiiEntitiesConfig: Match.arrayWith([
            Match.objectLike({
              Type: 'CREDIT_DEBIT_CARD_NUMBER',
              Action: 'ANONYMIZE',
            }),
          ]),
        },
      });
    });

    it('should BLOCK unrelated patient identifiers via regex', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        SensitiveInformationPolicyConfig: {
          RegexesConfig: Match.arrayWith([
            Match.objectLike({
              Name: 'unrelated-patient-identifier',
              Action: 'BLOCK',
            }),
          ]),
        },
      });
    });
  });

  describe('Contextual Grounding Policy', () => {
    it('should configure grounding threshold at 0.7', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        ContextualGroundingPolicyConfig: {
          FiltersConfig: Match.arrayWith([
            Match.objectLike({
              Type: 'GROUNDING',
              Threshold: 0.7,
            }),
          ]),
        },
      });
    });

    it('should configure relevance threshold at 0.6', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        ContextualGroundingPolicyConfig: {
          FiltersConfig: Match.arrayWith([
            Match.objectLike({
              Type: 'RELEVANCE',
              Threshold: 0.6,
            }),
          ]),
        },
      });
    });
  });

  describe('Guardrail Version', () => {
    it('should create a guardrail version', () => {
      const { template } = createTestStack();

      template.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
    });

    it('should reference the guardrail in the version', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::GuardrailVersion', {
        GuardrailIdentifier: Match.anyValue(),
        Description: Match.stringLikeRegexp('Initial version'),
      });
    });
  });

  describe('Tags', () => {
    it('should tag the guardrail with Project=DenialAppealAgent', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Project', Value: 'DenialAppealAgent' }),
        ]),
      });
    });

    it('should tag the guardrail with Component=ContentSafety', () => {
      const { template } = createTestStack();

      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Component', Value: 'ContentSafety' }),
        ]),
      });
    });
  });

  describe('Stack Outputs', () => {
    it('should output the guardrail ID', () => {
      const { template } = createTestStack();

      template.hasOutput('GuardrailId', {
        Description: 'Bedrock Guardrail ID for use by Lambda functions',
      });
    });

    it('should output the guardrail version', () => {
      const { template } = createTestStack();

      template.hasOutput('GuardrailVersion', {
        Description: 'Bedrock Guardrail version number for use by Lambda functions',
      });
    });

    it('should output the guardrail ARN', () => {
      const { template } = createTestStack();

      template.hasOutput('GuardrailArn', {
        Description: 'Bedrock Guardrail ARN',
      });
    });

    it('should export guardrail ID for cross-stack references', () => {
      const { template } = createTestStack();

      template.hasOutput('GuardrailId', {
        Export: { Name: 'DenialAppealGuardrailId' },
      });
    });

    it('should export guardrail version for cross-stack references', () => {
      const { template } = createTestStack();

      template.hasOutput('GuardrailVersion', {
        Export: { Name: 'DenialAppealGuardrailVersion' },
      });
    });
  });
});
