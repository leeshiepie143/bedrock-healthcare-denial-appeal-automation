/**
 * CDK Stack defining the Amazon Bedrock Agent and Knowledge Base
 * for the optional agentic workflow mode.
 *
 * This stack is gated behind the `ENABLE_AGENTIC_MODE` feature flag
 * (CDK context or environment variable). When disabled, no resources
 * are created.
 *
 * The Bedrock Agent orchestrates denial appeal actions autonomously,
 * using the same Lambda functions as the deterministic Step Functions pipeline.
 *
 * Requirements: 10.4
 */

import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Props for the AgentStack, accepting references to existing infrastructure.
 */
export interface AgentStackProps extends cdk.StackProps {
  /** Guardrail ID from the GuardrailsStack */
  guardrailId: string;
  /** Guardrail version from the GuardrailsStack */
  guardrailVersion: string;
  /** Lambda function ARNs for action groups */
  actionGroupLambdaArns: {
    ingestion: string;
    classifier: string;
    evidence: string;
    viability: string;
    generator: string;
    outcomes: string;
  };
}

/**
 * CDK Stack for the Bedrock Agent and Knowledge Base.
 * All resources are conditionally created based on the ENABLE_AGENTIC_MODE flag.
 */
export class AgentStack extends cdk.Stack {
  /** The Bedrock Agent resource (undefined if feature flag is disabled) */
  public readonly agent?: bedrock.CfnAgent;

  /** The Knowledge Base resource (undefined if feature flag is disabled) */
  public readonly knowledgeBase?: bedrock.CfnKnowledgeBase;

  /** The S3 bucket for knowledge base data sources */
  public readonly knowledgeBaseBucket?: s3.Bucket;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // ─── Feature Flag Check ───────────────────────────────────────────────
    const enableAgenticMode =
      this.node.tryGetContext('ENABLE_AGENTIC_MODE') === 'true' ||
      process.env.ENABLE_AGENTIC_MODE === 'true';

    if (!enableAgenticMode) {
      return;
    }

    // Tags applied to all resources in this stack
    cdk.Tags.of(this).add('Project', 'DenialAppealAgent');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Component', 'AgenticMode');

    // ─── Knowledge Base S3 Bucket ─────────────────────────────────────────

    this.knowledgeBaseBucket = new s3.Bucket(this, 'KnowledgeBaseBucket', {
      bucketName: cdk.Fn.sub('denial-appeal-kb-${AWS::AccountId}-${AWS::Region}'),
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── Knowledge Base IAM Role ──────────────────────────────────────────

    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      roleName: 'denial-appeal-kb-role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'IAM role for the Denial Appeal Agent Knowledge Base',
    });

    this.knowledgeBaseBucket.grantRead(knowledgeBaseRole);

    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:ListFoundationModels',
          'bedrock:InvokeModel',
        ],
        resources: ['*'],
      })
    );

    // ─── Knowledge Base ───────────────────────────────────────────────────

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'DenialAppealKnowledgeBase', {
      name: 'denial-appeal-knowledge-base',
      description: 'Knowledge base containing payer policies, LCD/NCD documents, and CARC/RARC reference data for the Denial Appeal Agent.',
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: cdk.Fn.sub('arn:aws:aoss:${AWS::Region}:${AWS::AccountId}:collection/denial-appeal-kb'),
          vectorIndexName: 'denial-appeal-kb-index',
          fieldMapping: {
            vectorField: 'embedding',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    });

    // ─── Knowledge Base Data Source ───────────────────────────────────────

    new bedrock.CfnDataSource(this, 'PayerPoliciesDataSource', {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: 'payer-policies',
      description: 'Payer-specific appeal policies, LCD/NCD documents, and CARC/RARC reference data',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: this.knowledgeBaseBucket.bucketArn,
          inclusionPrefixes: [
            'payer-policies/',
            'lcd-ncd-docs/',
            'carc-rarc-reference/',
          ],
        },
      },
    });

    // ─── Agent IAM Role ───────────────────────────────────────────────────

    const agentRole = new iam.Role(this, 'AgentRole', {
      roleName: 'denial-appeal-agent-role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'IAM role for the Denial Appeal Bedrock Agent',
    });

    // Allow agent to invoke the foundation model
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
        ],
      })
    );

    // Allow agent to retrieve from knowledge base
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
        ],
        resources: [this.knowledgeBase.attrKnowledgeBaseArn],
      })
    );

    // Allow agent to invoke action group Lambda functions
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: Object.values(props.actionGroupLambdaArns),
      })
    );

    // Allow agent to apply guardrails
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:ApplyGuardrail',
        ],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:guardrail/${props.guardrailId}`,
        ],
      })
    );

    // ─── Bedrock Agent ────────────────────────────────────────────────────

    this.agent = new bedrock.CfnAgent(this, 'DenialAppealAgent', {
      agentName: 'denial-appeal-agent',
      description: 'Healthcare revenue cycle specialist agent for managing denial appeals.',
      instruction: 'You are a healthcare revenue cycle specialist that helps users manage denial appeals. You can ingest denial documents, classify denial reasons, retrieve clinical evidence, assess appeal viability, generate appeal letters, and record outcomes.',
      foundationModel: 'anthropic.claude-3-sonnet-20240229-v1:0',
      agentResourceRoleArn: agentRole.roleArn,
      idleSessionTtlInSeconds: 600, // 10 minutes
      guardrailConfiguration: {
        guardrailIdentifier: props.guardrailId,
        guardrailVersion: props.guardrailVersion,
      },
      knowledgeBases: [
        {
          knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
          description: 'Contains payer policies, LCD/NCD documents, and CARC/RARC reference data for denial appeal research.',
          knowledgeBaseState: 'ENABLED',
        },
      ],
      actionGroups: [
        {
          actionGroupName: 'ingest-denial',
          description: 'Ingest and parse denial documents from S3',
          actionGroupExecutor: {
            lambda: props.actionGroupLambdaArns.ingestion,
          },
          apiSchema: {
            payload: this.getIngestDenialSchema(),
          },
        },
        {
          actionGroupName: 'classify-denial',
          description: 'Classify denial reasons into CARC/RARC codes',
          actionGroupExecutor: {
            lambda: props.actionGroupLambdaArns.classifier,
          },
          apiSchema: {
            payload: this.getClassifyDenialSchema(),
          },
        },
        {
          actionGroupName: 'retrieve-evidence',
          description: 'Retrieve clinical evidence from HealthLake',
          actionGroupExecutor: {
            lambda: props.actionGroupLambdaArns.evidence,
          },
          apiSchema: {
            payload: this.getRetrieveEvidenceSchema(),
          },
        },
        {
          actionGroupName: 'assess-viability',
          description: 'Assess appeal viability and calculate success probability',
          actionGroupExecutor: {
            lambda: props.actionGroupLambdaArns.viability,
          },
          apiSchema: {
            payload: this.getAssessViabilitySchema(),
          },
        },
        {
          actionGroupName: 'generate-appeal',
          description: 'Generate appeal letters using clinical evidence and regulatory references',
          actionGroupExecutor: {
            lambda: props.actionGroupLambdaArns.generator,
          },
          apiSchema: {
            payload: this.getGenerateAppealSchema(),
          },
        },
        {
          actionGroupName: 'record-outcome',
          description: 'Record appeal outcomes for analytics and model improvement',
          actionGroupExecutor: {
            lambda: props.actionGroupLambdaArns.outcomes,
          },
          apiSchema: {
            payload: this.getRecordOutcomeSchema(),
          },
        },
      ],
      tags: {
        Project: 'DenialAppealAgent',
        Component: 'AgenticMode',
      },
    });

    // ─── Agent Alias ─────────────────────────────────────────────────────

    const agentAlias = new bedrock.CfnAgentAlias(this, 'DenialAppealAgentAlias', {
      agentId: this.agent.attrAgentId,
      agentAliasName: 'live',
      description: 'Live alias for the Denial Appeal Agent',
    });

    agentAlias.addDependency(this.agent);

    // ─── Stack Outputs ────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'AgentId', {
      value: this.agent.attrAgentId,
      description: 'Bedrock Agent ID for the Denial Appeal Agent',
      exportName: 'DenialAppealAgentId',
    });

    new cdk.CfnOutput(this, 'AgentAliasArn', {
      value: agentAlias.attrAgentAliasArn,
      description: 'Bedrock Agent Alias ARN for the Denial Appeal Agent',
      exportName: 'DenialAppealAgentAliasArn',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: this.knowledgeBase.attrKnowledgeBaseId,
      description: 'Knowledge Base ID for payer policies and reference data',
      exportName: 'DenialAppealKnowledgeBaseId',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseBucketName', {
      value: this.knowledgeBaseBucket.bucketName,
      description: 'S3 bucket for knowledge base data sources',
    });
  }

  // ─── OpenAPI Schema Helpers ─────────────────────────────────────────────

  private getIngestDenialSchema(): string {
    return JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Ingest Denial', version: '1.0.0' },
      paths: {
        '/ingest': {
          post: {
            operationId: 'ingestDenial',
            description: 'Ingest a denial document from S3 and extract denial record fields',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      s3_key: { type: 'string', description: 'S3 object key of the denial document' },
                      tenant_id: { type: 'string', description: 'Tenant identifier' },
                    },
                    required: ['s3_key', 'tenant_id'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Successfully ingested denial record',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/DenialRecord' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          DenialRecord: {
            type: 'object',
            properties: {
              claim_id: { type: 'string' },
              patient_id: { type: 'string' },
              payer_id: { type: 'string' },
              denial_date: { type: 'string', format: 'date-time' },
              denied_amount: { type: 'number' },
              source_format: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    });
  }

  private getClassifyDenialSchema(): string {
    return JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Classify Denial', version: '1.0.0' },
      paths: {
        '/classify': {
          post: {
            operationId: 'classifyDenial',
            description: 'Classify denial reasons into CARC/RARC codes',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      claim_id: { type: 'string', description: 'Claim identifier to classify' },
                      tenant_id: { type: 'string', description: 'Tenant identifier' },
                    },
                    required: ['claim_id', 'tenant_id'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Successfully classified denial',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ClassifiedDenial' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ClassifiedDenial: {
            type: 'object',
            properties: {
              claim_id: { type: 'string' },
              carc_codes: { type: 'array', items: { type: 'object' } },
              rarc_codes: { type: 'array', items: { type: 'object' } },
              classification_method: { type: 'string' },
              review_status: { type: 'string' },
            },
          },
        },
      },
    });
  }

  private getRetrieveEvidenceSchema(): string {
    return JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Retrieve Evidence', version: '1.0.0' },
      paths: {
        '/evidence': {
          post: {
            operationId: 'retrieveEvidence',
            description: 'Retrieve clinical evidence from HealthLake for a denial claim',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      claim_id: { type: 'string', description: 'Claim identifier to retrieve evidence for' },
                      tenant_id: { type: 'string', description: 'Tenant identifier' },
                    },
                    required: ['claim_id', 'tenant_id'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Successfully retrieved evidence package',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/EvidencePackage' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          EvidencePackage: {
            type: 'object',
            properties: {
              claim_id: { type: 'string' },
              patient_id: { type: 'string' },
              evidence_items: { type: 'array', items: { type: 'object' } },
              total_evidence_count: { type: 'integer' },
              manual_review_required: { type: 'boolean' },
            },
          },
        },
      },
    });
  }

  private getAssessViabilitySchema(): string {
    return JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Assess Viability', version: '1.0.0' },
      paths: {
        '/viability': {
          post: {
            operationId: 'assessViability',
            description: 'Assess appeal viability and calculate success probability',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      claim_id: { type: 'string', description: 'Claim identifier to assess' },
                      tenant_id: { type: 'string', description: 'Tenant identifier' },
                    },
                    required: ['claim_id', 'tenant_id'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Successfully assessed viability',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ViabilityAssessment' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ViabilityAssessment: {
            type: 'object',
            properties: {
              claim_id: { type: 'string' },
              viability_score: { type: 'number' },
              recommendation: { type: 'string', enum: ['pursue', 'do_not_pursue'] },
              confidence_interval: { type: 'object' },
              rationale: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    });
  }

  private getGenerateAppealSchema(): string {
    return JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Generate Appeal', version: '1.0.0' },
      paths: {
        '/generate': {
          post: {
            operationId: 'generateAppeal',
            description: 'Generate an appeal letter using clinical evidence and regulatory references',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      claim_id: { type: 'string', description: 'Claim identifier to generate appeal for' },
                      tenant_id: { type: 'string', description: 'Tenant identifier' },
                    },
                    required: ['claim_id', 'tenant_id'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Successfully generated appeal letter',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/AppealLetter' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          AppealLetter: {
            type: 'object',
            properties: {
              claim_id: { type: 'string' },
              version: { type: 'integer' },
              letter_body: { type: 'string' },
              template_used: { type: 'string' },
              incomplete_sections: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    });
  }

  private getRecordOutcomeSchema(): string {
    return JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Record Outcome', version: '1.0.0' },
      paths: {
        '/outcome': {
          post: {
            operationId: 'recordOutcome',
            description: 'Record an appeal outcome for analytics and model improvement',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      claim_id: { type: 'string', description: 'Claim identifier' },
                      tenant_id: { type: 'string', description: 'Tenant identifier' },
                      outcome_type: { type: 'string', enum: ['overturn', 'partial_overturn', 'upheld'] },
                      denial_reason_code: { type: 'string', description: 'CARC code for the denial' },
                      payer_id: { type: 'string', description: 'Payer identifier' },
                      time_to_resolution_days: { type: 'integer', description: 'Days from appeal to resolution' },
                      recovered_amount: { type: 'number', description: 'Amount recovered in USD' },
                    },
                    required: ['claim_id', 'tenant_id', 'outcome_type', 'denial_reason_code', 'payer_id', 'time_to_resolution_days'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Successfully recorded outcome',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/AppealOutcome' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          AppealOutcome: {
            type: 'object',
            properties: {
              claim_id: { type: 'string' },
              outcome_type: { type: 'string' },
              denial_reason_code: { type: 'string' },
              payer_id: { type: 'string' },
              time_to_resolution_days: { type: 'integer' },
              recovered_amount: { type: 'number' },
            },
          },
        },
      },
    });
  }
}
