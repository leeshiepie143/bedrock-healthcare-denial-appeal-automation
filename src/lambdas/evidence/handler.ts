/**
 * Evidence Retrieval Handler Lambda
 *
 * Step Functions task handler for the evidence retrieval step.
 * Orchestrates: HealthLake query → FHIR text extraction → entity extraction
 * → relevance scoring → filtering → DynamoDB storage.
 *
 * Flags for manual review when no evidence is found or a timeout occurs,
 * and sends SNS notifications for manual review cases.
 *
 * Requirements: 3.3, 3.7
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { ClassifiedDenial, DenialRecord, EvidencePackage } from '@shared/models';
import { buildTenantPK, buildEvidenceSK } from '@shared/dynamodb';
import { queryHealthLake, type FhirResource, type HealthLakeQueryResult } from './healthlake-query';
import {
  extractAndScoreEvidence,
  type FhirResourceInput,
  type DenialContext,
} from './entity-extractor';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getSnsTopicArn(): string {
  return process.env.SNS_TOPIC_ARN || '';
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;
let snsClient: SNSClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    const baseClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
    dynamoClient = DynamoDBDocumentClient.from(baseClient);
  }
  return dynamoClient;
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
  sns?: SNSClient;
}): void {
  if (clients.dynamo) dynamoClient = clients.dynamo;
  if (clients.sns) snsClient = clients.sns;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  dynamoClient = null;
  snsClient = null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input event from Step Functions — contains the classified denial and original denial record. */
export interface EvidenceHandlerInput {
  classifiedDenial: ClassifiedDenial;
  denialRecord: DenialRecord;
}

/** Result returned by the handler to Step Functions. */
export interface EvidenceHandlerResult {
  evidencePackage: EvidencePackage;
  manualReviewRequired: boolean;
  timedOut: boolean;
}

// ─── FHIR Resource Text Extraction ─────────────────────────────────────────

/**
 * Extracts text content from a FHIR resource based on resource type:
 * - Encounter: text.div or reasonCode[0].text
 * - Procedure: text.div or code.text
 * - Condition: text.div or code.text
 * - DiagnosticReport: text.div or conclusion
 * - DocumentReference: description or content[0].attachment.data (base64 decoded)
 *
 * Falls back to generic extraction (text.div, note[].text, code.text, description)
 * for any fields not covered by resource-type-specific logic.
 */
export function extractTextFromFhirResource(resource: FhirResource): string {
  const textParts: string[] = [];

  // text.div — narrative text (common across all resource types)
  const text = resource.text as { div?: string } | undefined;
  if (text?.div) {
    // Strip HTML tags from narrative div
    textParts.push(stripHtmlTags(text.div));
  }

  // Resource-type-specific extraction
  switch (resource.resourceType) {
    case 'Encounter': {
      // reasonCode[0].text for Encounter
      const reasonCode = resource.reasonCode as Array<{ text?: string }> | undefined;
      if (Array.isArray(reasonCode) && reasonCode.length > 0 && reasonCode[0].text) {
        textParts.push(reasonCode[0].text);
      }
      break;
    }
    case 'Procedure':
    case 'Condition': {
      // code.text for Procedure and Condition
      const code = resource.code as { text?: string } | undefined;
      if (code?.text) {
        textParts.push(code.text);
      }
      break;
    }
    case 'DiagnosticReport': {
      // conclusion for DiagnosticReport
      const conclusion = resource.conclusion as string | undefined;
      if (typeof conclusion === 'string' && conclusion.length > 0) {
        textParts.push(conclusion);
      }
      break;
    }
    case 'DocumentReference': {
      // description for DocumentReference
      const description = resource.description as string | undefined;
      if (typeof description === 'string' && description.length > 0) {
        textParts.push(description);
      }
      // content[0].attachment.data (base64 decoded) for DocumentReference
      const content = resource.content as Array<{
        attachment?: { data?: string; contentType?: string };
      }> | undefined;
      if (Array.isArray(content) && content.length > 0 && content[0].attachment?.data) {
        try {
          const decoded = Buffer.from(content[0].attachment.data, 'base64').toString('utf-8');
          textParts.push(decoded);
        } catch {
          // Skip if base64 decoding fails
        }
      }
      break;
    }
    default: {
      // Generic fallback for unknown resource types
      const code = resource.code as { text?: string } | undefined;
      if (code?.text) {
        textParts.push(code.text);
      }
      const description = resource.description as string | undefined;
      if (typeof description === 'string' && description.length > 0) {
        textParts.push(description);
      }
      break;
    }
  }

  // note[].text — clinical notes (common across resource types)
  const notes = resource.note as Array<{ text?: string }> | undefined;
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (note.text) {
        textParts.push(note.text);
      }
    }
  }

  return textParts.join(' ').trim();
}

/**
 * Strips HTML tags from a string (used for FHIR narrative div content).
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Converts raw FHIR resources into FhirResourceInput objects for entity extraction.
 */
export function convertToFhirResourceInputs(resources: FhirResource[]): FhirResourceInput[] {
  return resources.map((resource) => ({
    fhir_resource_id: resource.id,
    fhir_resource_type: resource.resourceType,
    date: getResourceDateForInput(resource),
    authoring_provider: getAuthoringProvider(resource),
    text_content: extractTextFromFhirResource(resource),
  }));
}

/**
 * Extracts a date string from a FHIR resource for the evidence item.
 */
function getResourceDateForInput(resource: FhirResource): string {
  const dateFields = [
    'date',
    'effectiveDateTime',
    'recordedDate',
    'created',
  ];

  for (const field of dateFields) {
    const value = resource[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  // Try period.start
  const period = resource.period as { start?: string } | undefined;
  if (period?.start) {
    return period.start;
  }

  // Fallback to meta.lastUpdated
  if (resource.meta?.lastUpdated) {
    return resource.meta.lastUpdated;
  }

  return new Date().toISOString();
}

/**
 * Extracts the authoring provider from a FHIR resource.
 * Looks at common provider reference fields.
 */
function getAuthoringProvider(resource: FhirResource): string {
  // Try performer (common in Procedure, DiagnosticReport)
  const performer = resource.performer as Array<{ display?: string; reference?: string }> | undefined;
  if (Array.isArray(performer) && performer.length > 0) {
    return performer[0].display || performer[0].reference || 'Unknown';
  }

  // Try author (common in DocumentReference)
  const author = resource.author as Array<{ display?: string; reference?: string }> | undefined;
  if (Array.isArray(author) && author.length > 0) {
    return author[0].display || author[0].reference || 'Unknown';
  }

  // Try recorder (common in Condition)
  const recorder = resource.recorder as { display?: string; reference?: string } | undefined;
  if (recorder?.display || recorder?.reference) {
    return recorder.display || recorder.reference || 'Unknown';
  }

  // Try participant (common in Encounter)
  const participant = resource.participant as Array<{
    individual?: { display?: string; reference?: string };
  }> | undefined;
  if (Array.isArray(participant) && participant.length > 0) {
    const individual = participant[0].individual;
    if (individual?.display || individual?.reference) {
      return individual.display || individual.reference || 'Unknown';
    }
  }

  return 'Unknown';
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Step Functions task handler for the evidence retrieval step.
 *
 * Receives a ClassifiedDenial and DenialRecord from the previous step (classification),
 * queries HealthLake for clinical evidence, extracts entities, scores relevance,
 * stores the EvidencePackage in DynamoDB, and returns it for the next step.
 */
export async function handler(event: EvidenceHandlerInput): Promise<EvidenceHandlerResult> {
  const { classifiedDenial, denialRecord } = event;
  const { claim_id, patient_id, tenant_id, denial_date } = denialRecord;

  console.info(
    `[EVIDENCE] Processing claim_id=${claim_id}, patient_id=${patient_id}, tenant_id=${tenant_id}`
  );

  const startTime = Date.now();

  // Step 1: Query HealthLake for FHIR resources
  const queryResult: HealthLakeQueryResult = await queryHealthLake({
    patientId: patient_id,
    dateOfService: denial_date,
  });

  console.info(
    `[EVIDENCE] HealthLake query complete: retrieved=${queryResult.returnedCount}, ` +
    `timedOut=${queryResult.timedOut}, capped=${queryResult.capped}`
  );

  // Step 2: Convert FHIR resources to FhirResourceInput[] (extract text content)
  const fhirResourceInputs = convertToFhirResourceInputs(queryResult.resources);

  // Step 3: Extract entities and score evidence
  const denialContext: DenialContext = {
    carc_codes: classifiedDenial.carc_codes,
    raw_denial_reason_text: denialRecord.raw_denial_reason_text,
  };

  const extractionResult = await extractAndScoreEvidence(fhirResourceInputs, denialContext);

  // Step 4: Determine if manual review is required
  const noEvidenceFound = extractionResult.evidence_items.length === 0;
  const manualReviewRequired =
    noEvidenceFound ||
    queryResult.timedOut ||
    extractionResult.manual_review_required;

  // Step 5: Build the EvidencePackage
  const retrievalDurationMs = Date.now() - startTime;

  const evidencePackage: EvidencePackage = {
    PK: buildTenantPK(tenant_id),
    SK: buildEvidenceSK(claim_id),
    claim_id,
    patient_id,
    evidence_items: extractionResult.evidence_items,
    total_evidence_count: extractionResult.evidence_items.length,
    retrieval_timestamp: new Date().toISOString(),
    retrieval_duration_ms: retrievalDurationMs,
    manual_review_required: manualReviewRequired,
  };

  // Step 6: Store EvidencePackage in DynamoDB
  await storeEvidencePackage(evidencePackage);

  // Step 7: If manual review required, send SNS notification
  if (manualReviewRequired) {
    await sendManualReviewNotification(claim_id, patient_id, tenant_id, {
      noEvidenceFound,
      timedOut: queryResult.timedOut,
      comprehendFailure: extractionResult.manual_review_required,
    });
  }

  console.info(
    `[EVIDENCE] Evidence retrieval complete for claim_id=${claim_id}:`,
    {
      evidence_count: extractionResult.evidence_items.length,
      manual_review_required: manualReviewRequired,
      timed_out: queryResult.timedOut,
      duration_ms: retrievalDurationMs,
    }
  );

  return {
    evidencePackage,
    manualReviewRequired,
    timedOut: queryResult.timedOut,
  };
}

// ─── DynamoDB Storage ───────────────────────────────────────────────────────

/**
 * Stores the EvidencePackage record in DynamoDB.
 */
async function storeEvidencePackage(evidencePackage: EvidencePackage): Promise<void> {
  const dynamo = getDynamoClient();

  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: evidencePackage,
    })
  );

  console.info(
    `[EVIDENCE] Stored EvidencePackage: PK=${evidencePackage.PK}, SK=${evidencePackage.SK}`
  );
}

// ─── SNS Notifications ──────────────────────────────────────────────────────

interface ManualReviewReason {
  noEvidenceFound: boolean;
  timedOut: boolean;
  comprehendFailure: boolean;
}

/**
 * Sends an SNS notification when manual review is required.
 */
async function sendManualReviewNotification(
  claimId: string,
  patientId: string,
  tenantId: string,
  reason: ManualReviewReason
): Promise<void> {
  const topicArn = getSnsTopicArn();
  if (!topicArn) {
    console.warn('[EVIDENCE] SNS_TOPIC_ARN not configured, skipping notification');
    return;
  }

  const sns = getSnsClient();

  const reasons: string[] = [];
  if (reason.noEvidenceFound) reasons.push('No matching clinical evidence found');
  if (reason.timedOut) reasons.push('HealthLake query timed out');
  if (reason.comprehendFailure) reasons.push('Comprehend Medical entity extraction failed');

  const message = JSON.stringify({
    event: 'MANUAL_REVIEW_REQUIRED',
    claim_id: claimId,
    patient_id: patientId,
    tenant_id: tenantId,
    reasons,
    timestamp: new Date().toISOString(),
  });

  try {
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `[Denial Appeal] Manual Review Required - Claim ${claimId}`,
        Message: message,
        MessageAttributes: {
          event_type: {
            DataType: 'String',
            StringValue: 'MANUAL_REVIEW_REQUIRED',
          },
          tenant_id: {
            DataType: 'String',
            StringValue: tenantId,
          },
        },
      })
    );

    console.info(`[EVIDENCE] Sent manual review notification for claim_id=${claimId}`);
  } catch (error) {
    // Log but don't fail the handler — notification is best-effort
    console.error(
      `[EVIDENCE] Failed to send SNS notification for claim_id=${claimId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
