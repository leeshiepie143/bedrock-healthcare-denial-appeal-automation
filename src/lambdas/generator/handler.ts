/**
 * Appeal Generator Handler Lambda
 *
 * Step Functions task handler for the appeal letter generation step.
 * Orchestrates: viability check → regulatory reference lookup → letter generation
 * → citation validation → hallucination stripping → S3 storage → DynamoDB storage.
 *
 * Handles insufficient evidence by generating partial letters with flagged missing sections.
 *
 * Requirements: 5.9
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type {
  ViabilityAssessment,
  EvidencePackage,
  ClassifiedDenial,
  DenialRecord,
  AppealLetter,
} from '@shared/models';
import { buildTenantPK, buildLetterSK } from '@shared/dynamodb';
import {
  generateAppealLetter,
  type LetterGenerationInput,
} from './letter-generator';
import {
  lookupRegulatoryReferences,
  validateCitations,
  stripHallucinatedContent,
} from './citation-validator';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getLettersBucket(): string {
  return process.env.LETTERS_BUCKET || '';
}

function getSnsTopicArn(): string {
  return process.env.SNS_TOPIC_ARN || '';
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;
let s3Client: S3Client | null = null;
let snsClient: SNSClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    const baseClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
    dynamoClient = DynamoDBDocumentClient.from(baseClient);
  }
  return dynamoClient;
}

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return s3Client;
}

function getSnsClient(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return snsClient;
}

/** Allows injecting mock clients for testing. */
export function setClients(clients: {
  dynamo?: DynamoDBDocumentClient;
  s3?: S3Client;
  sns?: SNSClient;
}): void {
  if (clients.dynamo) dynamoClient = clients.dynamo;
  if (clients.s3) s3Client = clients.s3;
  if (clients.sns) snsClient = clients.sns;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  dynamoClient = null;
  s3Client = null;
  snsClient = null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input event from Step Functions. */
export interface GeneratorHandlerInput {
  viabilityAssessment: ViabilityAssessment;
  evidencePackage: EvidencePackage;
  classifiedDenial: ClassifiedDenial;
  denialRecord: DenialRecord;
}

/** Result returned by the handler to Step Functions. */
export interface GeneratorHandlerResult {
  appealLetter: AppealLetter | null;
  skipped: boolean;
  skipReason?: string;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Step Functions task handler for the appeal letter generation step.
 *
 * Receives a ViabilityAssessment, EvidencePackage, ClassifiedDenial, and DenialRecord
 * from the previous steps. Only generates a letter if the viability recommendation is 'pursue'.
 */
export async function handler(event: GeneratorHandlerInput): Promise<GeneratorHandlerResult> {
  const { viabilityAssessment, evidencePackage, classifiedDenial, denialRecord } = event;
  const { claim_id, tenant_id, payer_id } = denialRecord;

  console.info(
    `[GENERATOR] Processing claim_id=${claim_id}, tenant_id=${tenant_id}, recommendation=${viabilityAssessment.recommendation}`
  );

  // Step 1: Check if viability recommends pursuing
  if (viabilityAssessment.recommendation !== 'pursue') {
    console.info(
      `[GENERATOR] Skipping letter generation for claim_id=${claim_id}: recommendation is '${viabilityAssessment.recommendation}'`
    );
    return {
      appealLetter: null,
      skipped: true,
      skipReason: `Viability recommendation is '${viabilityAssessment.recommendation}' (score: ${viabilityAssessment.viability_score})`,
    };
  }

  // Step 2: Look up regulatory references
  const dynamo = getDynamoClient();
  const denialReasonCodes = classifiedDenial.carc_codes.map(c => c.code);
  const payerType = inferPayerType(payer_id);

  const regulatoryCitations = await lookupRegulatoryReferences(
    dynamo,
    denialReasonCodes,
    payerType,
    getTableName()
  );

  console.info(
    `[GENERATOR] Found ${regulatoryCitations.length} regulatory citations for claim_id=${claim_id}`
  );

  // Step 3: Generate appeal letter
  const generationInput: LetterGenerationInput = {
    viabilityAssessment,
    evidencePackage,
    classifiedDenial,
    denialRecord,
    regulatoryCitations,
  };

  const generationResult = await generateAppealLetter(generationInput);

  // Step 4: Validate citations
  const validationResult = validateCitations(
    generationResult.letter_body,
    evidencePackage
  );

  // Step 5: Strip hallucinated content
  const { cleanedBody, interventions } = stripHallucinatedContent(
    generationResult.letter_body,
    validationResult,
    denialRecord.patient_id
  );

  if (interventions.length > 0) {
    console.warn(
      `[GENERATOR] Stripped ${interventions.length} hallucinated citations for claim_id=${claim_id}`,
      interventions.map(i => ({ type: i.type, resourceId: i.resourceId }))
    );
  }

  // Step 6: Determine incomplete sections for partial letters
  const incompleteSections = buildIncompleteSections(
    generationResult.incomplete_sections,
    evidencePackage,
    cleanedBody
  );

  // Add note to letter body if there are incomplete sections
  const finalLetterBody = incompleteSections.length > 0
    ? appendIncompleteNote(cleanedBody, incompleteSections)
    : cleanedBody;

  // Step 7: Build the full AppealLetter object
  const version = 1;
  const appealLetter: AppealLetter = {
    PK: buildTenantPK(tenant_id),
    SK: buildLetterSK(claim_id, version),
    claim_id,
    version,
    letter_body: finalLetterBody,
    metadata: generationResult.metadata,
    template_used: generationResult.template_used,
    payer_template_available: generationResult.payer_template_available,
    incomplete_sections: incompleteSections,
    user_edited: false,
    generated_at: new Date().toISOString(),
  };

  // Step 8: Store letter body in S3
  const s3Key = `letters/${tenant_id}/${claim_id}/v${version}.txt`;
  await storeLetterInS3(s3Key, finalLetterBody);

  // Step 9: Store AppealLetter record in DynamoDB
  await storeAppealLetter(appealLetter);

  // Step 10: Notify if partial letter
  if (incompleteSections.length > 0) {
    await notifyPartialLetter(claim_id, tenant_id, incompleteSections);
  }

  console.info(
    `[GENERATOR] Appeal letter generated for claim_id=${claim_id}:`,
    {
      version,
      template_used: generationResult.template_used,
      payer_template_available: generationResult.payer_template_available,
      incomplete_sections: incompleteSections,
      citations_stripped: interventions.length,
      letter_length: finalLetterBody.length,
      s3_key: s3Key,
    }
  );

  return { appealLetter, skipped: false };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Infers the payer type from the payer ID for regulatory reference lookup.
 * In production, this would query a payer registry. For now, uses simple heuristics.
 */
function inferPayerType(payerId: string): string {
  const lowerPayerId = payerId.toLowerCase();
  if (lowerPayerId.includes('medicare')) return 'medicare';
  if (lowerPayerId.includes('medicaid')) return 'medicaid';
  return 'commercial';
}

/**
 * Builds the final list of incomplete sections, combining generator-detected
 * sections with additional checks for insufficient evidence.
 */
function buildIncompleteSections(
  generatorIncompleteSections: string[],
  evidencePackage: EvidencePackage,
  letterBody: string
): string[] {
  const incomplete = new Set(generatorIncompleteSections);

  // Check if evidence is insufficient
  if (evidencePackage.evidence_items.length === 0) {
    incomplete.add('clinical_justification');
  }

  // Check if letter body is empty or very short (guardrail blocked)
  if (!letterBody || letterBody.trim().length < 50) {
    incomplete.add('letter_body');
  }

  return [...incomplete];
}

/**
 * Appends a note to the letter body indicating which sections need manual completion.
 */
function appendIncompleteNote(letterBody: string, incompleteSections: string[]): string {
  const sectionList = incompleteSections
    .map(s => `  - ${formatSectionName(s)}`)
    .join('\n');

  const note = `\n\n---\nNOTE: This letter is incomplete. The following sections require manual completion before submission:\n${sectionList}\n\nPlease review and provide the missing documentation or information for the flagged sections.\n---`;

  return letterBody + note;
}

/**
 * Formats a section identifier into a human-readable name.
 */
function formatSectionName(section: string): string {
  return section
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Storage ────────────────────────────────────────────────────────────────

/**
 * Stores the letter body in S3.
 */
async function storeLetterInS3(key: string, body: string): Promise<void> {
  const bucket = getLettersBucket();
  if (!bucket) {
    console.warn('[GENERATOR] LETTERS_BUCKET not configured, skipping S3 storage');
    return;
  }

  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'text/plain',
      ServerSideEncryption: 'aws:kms',
    })
  );

  console.info(`[GENERATOR] Stored letter body in S3: s3://${bucket}/${key}`);
}

/**
 * Stores the AppealLetter record in DynamoDB.
 */
async function storeAppealLetter(letter: AppealLetter): Promise<void> {
  const dynamo = getDynamoClient();

  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: letter,
    })
  );

  console.info(
    `[GENERATOR] Stored AppealLetter: PK=${letter.PK}, SK=${letter.SK}`
  );
}

/**
 * Sends an SNS notification when a partial letter is generated.
 */
async function notifyPartialLetter(
  claimId: string,
  tenantId: string,
  incompleteSections: string[]
): Promise<void> {
  const topicArn = getSnsTopicArn();
  if (!topicArn) {
    console.warn('[GENERATOR] SNS_TOPIC_ARN not configured, skipping notification');
    return;
  }

  const sns = getSnsClient();
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `Partial Appeal Letter Generated - Claim ${claimId}`,
      Message: JSON.stringify({
        event: 'partial_letter_generated',
        claim_id: claimId,
        tenant_id: tenantId,
        incomplete_sections: incompleteSections,
        message: `Appeal letter for claim ${claimId} was generated with incomplete sections. Manual review required.`,
      }),
      MessageAttributes: {
        tenant_id: { DataType: 'String', StringValue: tenantId },
        event_type: { DataType: 'String', StringValue: 'partial_letter_generated' },
      },
    })
  );

  console.info(
    `[GENERATOR] Sent partial letter notification for claim_id=${claimId}`
  );
}
