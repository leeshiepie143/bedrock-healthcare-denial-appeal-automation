/**
 * Classifier Handler Lambda
 *
 * Step Functions task handler for the classification step.
 * Routes denial records to the appropriate classifier based on source format:
 * - EDI 835/277 → Structured EDI classifier
 * - PDF/TIFF/PNG/JPEG → NLP (Bedrock) classifier
 *
 * After classification, stores the Classified_Denial in DynamoDB and
 * logs any guardrail interventions to CloudWatch.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DenialRecord, ClassifiedDenial, SourceFormat } from '@shared/models';
import { buildTenantPK, buildClassificationSK } from '@shared/dynamodb';
import { classifyStructuredEDI } from './structured-classifier';
import { classifyWithNlp } from './nlp-classifier';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    const baseClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
    dynamoClient = DynamoDBDocumentClient.from(baseClient);
  }
  return dynamoClient;
}

/** Allows injecting mock clients for testing. */
export function setClients(clients: { dynamo?: DynamoDBDocumentClient }): void {
  if (clients.dynamo) dynamoClient = clients.dynamo;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  dynamoClient = null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Source formats that route to the structured EDI classifier */
const STRUCTURED_FORMATS: Set<SourceFormat> = new Set(['edi_835', 'edi_277']);

/** Source formats that route to the NLP classifier */
const UNSTRUCTURED_FORMATS: Set<SourceFormat> = new Set(['pdf', 'tiff', 'png', 'jpeg']);

/** Result returned by the handler to Step Functions */
export interface ClassifierHandlerResult {
  classifiedDenial: ClassifiedDenial;
  classificationMethod: 'structured_edi' | 'bedrock_nlp';
  guardrailIntervened: boolean;
}

// ─── Routing Logic ──────────────────────────────────────────────────────────

/**
 * Determines whether a source format should use the structured or NLP classifier.
 */
export function isStructuredFormat(sourceFormat: SourceFormat): boolean {
  return STRUCTURED_FORMATS.has(sourceFormat);
}

/**
 * Determines whether a source format should use the NLP classifier.
 */
export function isUnstructuredFormat(sourceFormat: SourceFormat): boolean {
  return UNSTRUCTURED_FORMATS.has(sourceFormat);
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Step Functions task handler for the classification step.
 *
 * Receives a DenialRecord from the previous step (ingestion), routes to the
 * appropriate classifier, stores the result in DynamoDB, and returns the
 * ClassifiedDenial for the next step in the pipeline.
 */
export async function handler(event: DenialRecord): Promise<ClassifierHandlerResult> {
  const { claim_id, source_format, tenant_id } = event;

  console.info(
    `[CLASSIFIER] Processing claim_id=${claim_id}, source_format=${source_format}, tenant_id=${tenant_id}`
  );

  let classifiedDenial: ClassifiedDenial;
  let guardrailIntervened = false;

  if (isStructuredFormat(source_format)) {
    // Route to structured EDI classifier
    const dynamo = getDynamoClient();
    const result = await classifyStructuredEDI(event, dynamo, getTableName());
    classifiedDenial = result.classifiedDenial;

    if (result.unmappedCodes.length > 0) {
      console.warn(
        `[CLASSIFIER] Unmapped CARC codes for claim_id=${claim_id}:`,
        result.unmappedCodes
      );
    }
  } else if (isUnstructuredFormat(source_format)) {
    // Route to NLP classifier
    const nlpResult = await classifyWithNlp(event);
    guardrailIntervened = nlpResult.guardrail_intervened;

    // Build the full ClassifiedDenial object from NLP result
    classifiedDenial = {
      PK: buildTenantPK(tenant_id),
      SK: buildClassificationSK(claim_id),
      claim_id,
      carc_codes: nlpResult.carc_codes,
      rarc_codes: nlpResult.rarc_codes,
      classification_method: nlpResult.classification_method,
      dollar_ranking_available: false,
      review_status: nlpResult.review_status,
      classified_at: new Date().toISOString(),
    };
  } else {
    throw new Error(
      `[CLASSIFIER] Unsupported source_format="${source_format}" for claim_id=${claim_id}. ` +
      `Expected one of: ${[...STRUCTURED_FORMATS, ...UNSTRUCTURED_FORMATS].join(', ')}`
    );
  }

  // Store Classified_Denial in DynamoDB
  await storeClassifiedDenial(classifiedDenial);

  // Log guardrail interventions to CloudWatch
  if (guardrailIntervened) {
    logGuardrailIntervention(claim_id, tenant_id, source_format);
  }

  console.info(
    `[CLASSIFIER] Classification complete for claim_id=${claim_id}:`,
    {
      method: classifiedDenial.classification_method,
      review_status: classifiedDenial.review_status,
      carc_count: classifiedDenial.carc_codes.length,
      rarc_count: classifiedDenial.rarc_codes.length,
      guardrail_intervened: guardrailIntervened,
    }
  );

  return {
    classifiedDenial,
    classificationMethod: classifiedDenial.classification_method,
    guardrailIntervened,
  };
}

// ─── DynamoDB Storage ───────────────────────────────────────────────────────

/**
 * Stores the ClassifiedDenial record in DynamoDB.
 */
async function storeClassifiedDenial(classifiedDenial: ClassifiedDenial): Promise<void> {
  const dynamo = getDynamoClient();

  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: classifiedDenial,
    })
  );

  console.info(
    `[CLASSIFIER] Stored ClassifiedDenial: PK=${classifiedDenial.PK}, SK=${classifiedDenial.SK}`
  );
}

// ─── Guardrail Logging ──────────────────────────────────────────────────────

/**
 * Logs guardrail intervention details to CloudWatch.
 * Uses structured JSON logging for CloudWatch Logs Insights queries.
 */
function logGuardrailIntervention(
  claimId: string,
  tenantId: string,
  sourceFormat: SourceFormat
): void {
  console.warn(
    JSON.stringify({
      event: 'GUARDRAIL_INTERVENTION',
      claim_id: claimId,
      tenant_id: tenantId,
      source_format: sourceFormat,
      guardrail_id: process.env.GUARDRAIL_ID || 'not_configured',
      guardrail_version: process.env.GUARDRAIL_VERSION || 'DRAFT',
      timestamp: new Date().toISOString(),
      message: 'Bedrock Guardrail intervened during NLP classification',
    })
  );
}
