import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';

/**
 * CDK Stack defining Amazon Bedrock Guardrails for the Denial Appeal Agent.
 *
 * Enforces content safety policies across all Bedrock model invocations
 * (classification, letter generation, letter parsing) to prevent hallucinations,
 * block PII leakage in outputs, and ensure clinical accuracy.
 *
 * Policies configured:
 * - Content filters: block hate, violence, sexual, misconduct at HIGH threshold
 * - Denied topics: financial advice, legal opinions, treatment recommendations
 * - Word filters: profanity (managed list), competitor names
 * - Sensitive information (PII): MASK SSN/credit cards in outputs; BLOCK unrelated patient IDs in inputs
 * - Contextual grounding: grounding threshold 0.7, relevance threshold 0.6
 */
export class GuardrailsStack extends cdk.Stack {
  /** The Bedrock Guardrail resource */
  public readonly guardrail: bedrock.CfnGuardrail;

  /** The Bedrock Guardrail version */
  public readonly guardrailVersion: bedrock.CfnGuardrailVersion;

  /** The guardrail ID for use by Lambda functions */
  public readonly guardrailId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Tags applied to all resources in this stack
    cdk.Tags.of(this).add('Project', 'DenialAppealAgent');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // ─── Bedrock Guardrail ────────────────────────────────────────────────

    this.guardrail = new bedrock.CfnGuardrail(this, 'DenialAppealGuardrail', {
      name: 'denial-appeal-agent-guardrail',
      description: 'Content safety guardrail for the Revenue Cycle Denial Appeal Agent. Prevents hallucinations, blocks PII leakage, and enforces clinical accuracy in all Bedrock model invocations.',
      blockedInputMessaging: 'Your input contains content that cannot be processed. Please remove any sensitive information or inappropriate content and try again.',
      blockedOutputsMessaging: 'The generated response was blocked due to content safety policies. Please review the input and try again.',

      // ─── Content Policy: Block harmful content at HIGH threshold ───────
      contentPolicyConfig: {
        filtersConfig: [
          {
            type: 'HATE',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
          },
          {
            type: 'VIOLENCE',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
          },
          {
            type: 'SEXUAL',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
          },
          {
            type: 'MISCONDUCT',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
          },
        ],
      },

      // ─── Topic Policy: Deny out-of-scope topics ───────────────────────
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'financial-advice',
            definition: 'Providing specific financial advice, investment recommendations, billing optimization strategies, or financial planning guidance that goes beyond the scope of claim appeal documentation.',
            type: 'DENY',
            examples: [
              'You should invest the recovered funds in a high-yield savings account.',
              'Based on your revenue cycle, I recommend restructuring your billing department.',
              'The best financial strategy for your practice is to outsource collections.',
            ],
          },
          {
            name: 'legal-opinions',
            definition: 'Providing legal opinions, legal advice, or interpretations of law that constitute practicing law, beyond citing specific regulatory references relevant to the denial appeal.',
            type: 'DENY',
            examples: [
              'In my legal opinion, the payer is liable for damages under state law.',
              'You should sue the insurance company for bad faith denial.',
              'This denial constitutes a breach of contract and you have grounds for litigation.',
            ],
          },
          {
            name: 'treatment-recommendations',
            definition: 'Recommending specific medical treatments, medications, procedures, or clinical interventions for patients. The system should only reference existing clinical documentation, not suggest new treatments.',
            type: 'DENY',
            examples: [
              'The patient should be prescribed a different medication for their condition.',
              'I recommend the patient undergo an additional MRI to support the appeal.',
              'Based on the diagnosis, the patient needs physical therapy three times per week.',
            ],
          },
        ],
      },

      // ─── Word Policy: Block profanity and competitor names ─────────────
      wordPolicyConfig: {
        managedWordListsConfig: [
          {
            type: 'PROFANITY',
          },
        ],
        wordsConfig: [
          { text: 'Waystar' },
          { text: 'AKASA' },
          { text: 'CombineHealth' },
        ],
      },

      // ─── Sensitive Information Policy: PII handling ────────────────────
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          {
            type: 'US_SOCIAL_SECURITY_NUMBER',
            action: 'ANONYMIZE',
          },
          {
            type: 'CREDIT_DEBIT_CARD_NUMBER',
            action: 'ANONYMIZE',
          },
        ],
        regexesConfig: [
          {
            name: 'unrelated-patient-identifier',
            description: 'Blocks input containing patient identifiers in free-text queries that do not appear to be part of structured clinical evidence. Only matches when preceded by common query patterns (e.g., "look up patient", "find MRN").',
            pattern: '(?i)\\b(?:look\\s*up|find|search|query|retrieve)\\s+(?:patient|mrn|medical record)\\s*(?:id|number|#)?\\s*[:=]?\\s*[A-Z0-9]{6,20}\\b',
            action: 'BLOCK',
          },
        ],
      },

      // ─── Contextual Grounding Policy ──────────────────────────────────
      contextualGroundingPolicyConfig: {
        filtersConfig: [
          {
            type: 'GROUNDING',
            threshold: 0.7,
          },
          {
            type: 'RELEVANCE',
            threshold: 0.6,
          },
        ],
      },

      // ─── Tags ─────────────────────────────────────────────────────────
      tags: [
        { key: 'Project', value: 'DenialAppealAgent' },
        { key: 'ManagedBy', value: 'CDK' },
        { key: 'Component', value: 'ContentSafety' },
      ],
    });

    // ─── Guardrail Version ────────────────────────────────────────────────
    // Creating a version pins the current configuration for stable use by Lambda functions.

    this.guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'DenialAppealGuardrailVersion', {
      guardrailIdentifier: this.guardrail.attrGuardrailId,
      description: 'Initial version of the denial appeal agent guardrail configuration.',
    });

    this.guardrailVersion.addDependency(this.guardrail);

    // Store the guardrail ID for cross-stack references
    this.guardrailId = this.guardrail.attrGuardrailId;

    // ─── Stack Outputs ────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'GuardrailId', {
      value: this.guardrail.attrGuardrailId,
      description: 'Bedrock Guardrail ID for use by Lambda functions',
      exportName: 'DenialAppealGuardrailId',
    });

    new cdk.CfnOutput(this, 'GuardrailVersion', {
      value: this.guardrailVersion.attrVersion,
      description: 'Bedrock Guardrail version number for use by Lambda functions',
      exportName: 'DenialAppealGuardrailVersion',
    });

    new cdk.CfnOutput(this, 'GuardrailArn', {
      value: this.guardrail.attrGuardrailArn,
      description: 'Bedrock Guardrail ARN',
      exportName: 'DenialAppealGuardrailArn',
    });
  }
}
