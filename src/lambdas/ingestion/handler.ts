/**
 * Ingestion Handler Lambda
 *
 * Main entry point triggered by S3 PutObject events on the ingestion bucket.
 * Routes documents to the appropriate processor (Textract or EDI parser),
 * validates extracted fields, handles quarantine logic, and stores valid
 * Denial_Records in DynamoDB.
 *
 * S3 key format: tenants/<tenant_id>/incoming/<filename>
 */

import { S3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { S3Event, S3EventRecord } from 'aws-lambda';
import type { DenialRecord, SourceFormat } from '@shared/models';
import { validateDenialRecordFields } from '@shared/validation';
import { buildTenantPK, buildDenialSK, buildGSI1Keys } from '@shared/dynamodb';
import { parseEDI, buildDeduplicationKey } from './edi-parser';
import { processDocument, type SupportedFormat } from './textract-processor';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getSnsTopicArn(): string {
  return process.env.SNS_TOPIC_ARN || '';
}

function getQuarantinePrefix(): string {
  return process.env.QUARANTINE_PREFIX || 'quarantine/';
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let s3Client: S3Client | null = null;
let dynamoClient: DynamoDBDocumentClient | null = null;
let snsClient: SNSClient | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return s3Client;
}

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    const baseClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
    dynamoClient = DynamoDBDocumentClient.from(baseClient);
  }
  return dynamoClient;
}

function getSNSClient(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return snsClient;
}

/** Allows injecting mock clients for testing. */
export function setClients(clients: {
  s3?: S3Client;
  dynamo?: DynamoDBDocumentClient;
  sns?: SNSClient;
}): void {
  if (clients.s3) s3Client = clients.s3;
  if (clients.dynamo) dynamoClient = clients.dynamo;
  if (clients.sns) snsClient = clients.sns;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  s3Client = null;
  dynamoClient = null;
  snsClient = null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Document routing target based on file extension/content */
export type ProcessorType = 'textract' | 'edi' | 'unsupported';

/** Result of the ingestion handler */
export interface IngestionResult {
  success: boolean;
  recordsProcessed: number;
  recordsStored: number;
  recordsQuarantined: number;
  recordsDuplicate: number;
  errors: IngestionError[];
}

export interface IngestionError {
  s3Key: string;
  error: string;
  quarantined: boolean;
}

/** Extracted fields from either processor, before validation */
export interface ExtractedFields {
  claim_id: string | null;
  patient_id: string | null;
  payer_id: string | null;
  denial_date: string | null;
  denied_amount: number | null;
  raw_denial_reason_text: string | null;
  source_format: SourceFormat;
}

// ─── File Extension Routing ─────────────────────────────────────────────────

const EDI_EXTENSIONS = new Set(['.edi', '.835', '.x12']);
const TEXTRACT_EXTENSIONS = new Set(['.pdf', '.tiff', '.tif', '.png', '.jpeg', '.jpg']);

const EXTENSION_TO_FORMAT: Record<string, SupportedFormat> = {
  '.pdf': 'pdf',
  '.tiff': 'tiff',
  '.tif': 'tiff',
  '.png': 'png',
  '.jpeg': 'jpeg',
  '.jpg': 'jpeg',
};

/**
 * Determines the processor type based on file extension.
 */
export function determineProcessorType(s3Key: string): ProcessorType {
  const extension = getFileExtension(s3Key).toLowerCase();
  if (EDI_EXTENSIONS.has(extension)) return 'edi';
  if (TEXTRACT_EXTENSIONS.has(extension)) return 'textract';
  return 'unsupported';
}

/**
 * Extracts the file extension from an S3 key.
 */
export function getFileExtension(s3Key: string): string {
  const filename = s3Key.split('/').pop() || '';
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return '';
  return filename.substring(dotIndex);
}

/**
 * Extracts tenant_id from the S3 key prefix.
 * Expected format: tenants/<tenant_id>/incoming/<filename>
 */
export function extractTenantId(s3Key: string): string | null {
  const match = s3Key.match(/^tenants\/([^/]+)\/incoming\//);
  return match ? match[1] : null;
}

/**
 * Checks if content starts with ISA (EDI indicator), used as a fallback
 * when file extension is ambiguous.
 */
export function isEDIContent(content: string): boolean {
  return content.trimStart().startsWith('ISA');
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Lambda handler triggered by S3 PutObject events.
 * Processes each record in the event, routing to the appropriate parser.
 */
export async function handler(event: S3Event): Promise<IngestionResult> {
  const result: IngestionResult = {
    success: true,
    recordsProcessed: 0,
    recordsStored: 0,
    recordsQuarantined: 0,
    recordsDuplicate: 0,
    errors: [],
  };

  for (const record of event.Records) {
    try {
      await processRecord(record, result);
    } catch (error) {
      const s3Key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`[INGESTION_ERROR] Unhandled error processing ${s3Key}:`, error);

      result.errors.push({
        s3Key,
        error: errorMessage,
        quarantined: false,
      });
      result.success = false;
    }
  }

  result.recordsProcessed = event.Records.length;
  return result;
}

// ─── Record Processing ──────────────────────────────────────────────────────

/**
 * Processes a single S3 event record through the ingestion pipeline.
 */
async function processRecord(record: S3EventRecord, result: IngestionResult): Promise<void> {
  const bucket = record.s3.bucket.name;
  const s3Key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const fileSize = record.s3.object.size;

  console.info(`[INGESTION] Processing: s3://${bucket}/${s3Key} (${fileSize} bytes)`);

  // Extract tenant_id from S3 key
  const tenantId = extractTenantId(s3Key);
  if (!tenantId) {
    console.warn(`[INGESTION] Cannot extract tenant_id from key: ${s3Key}`);
    await quarantineDocument(bucket, s3Key, 'Unable to extract tenant_id from S3 key path', fileSize);
    result.recordsQuarantined++;
    result.errors.push({ s3Key, error: 'Missing tenant_id in S3 key', quarantined: true });
    return;
  }

  // Determine processor type
  let processorType = determineProcessorType(s3Key);

  // If unsupported extension, try content-based detection
  if (processorType === 'unsupported') {
    const contentSniff = await getObjectContentSnippet(bucket, s3Key);
    if (contentSniff && isEDIContent(contentSniff)) {
      processorType = 'edi';
    }
  }

  // Quarantine unsupported formats
  if (processorType === 'unsupported') {
    const errorMsg = `Unsupported file format: ${getFileExtension(s3Key) || 'no extension'}`;
    console.warn(`[INGESTION] ${errorMsg} for ${s3Key}`);
    await quarantineDocument(bucket, s3Key, errorMsg, fileSize);
    result.recordsQuarantined++;
    result.errors.push({ s3Key, error: errorMsg, quarantined: true });
    return;
  }

  // Extract fields based on processor type
  let extractedFields: ExtractedFields;
  try {
    extractedFields = await extractFields(bucket, s3Key, processorType);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[INGESTION] Extraction failed for ${s3Key}:`, errorMessage);

    await quarantineDocument(bucket, s3Key, errorMessage, fileSize);
    result.recordsQuarantined++;
    result.errors.push({ s3Key, error: errorMessage, quarantined: true });
    return;
  }

  // Validate mandatory fields
  const validation = validateDenialRecordFields({
    claim_id: extractedFields.claim_id,
    patient_id: extractedFields.patient_id,
    payer_id: extractedFields.payer_id,
    denial_date: extractedFields.denial_date,
    denied_amount: extractedFields.denied_amount,
    raw_denial_reason_text: extractedFields.raw_denial_reason_text,
  });

  if (!validation.valid) {
    console.warn(`[INGESTION] Missing mandatory fields for ${s3Key}:`, validation.errors);

    await quarantineDocument(
      bucket,
      s3Key,
      `Missing mandatory fields: ${validation.errors.join('; ')}`,
      fileSize
    );
    result.recordsQuarantined++;
    result.errors.push({
      s3Key,
      error: `Missing mandatory fields: ${validation.errors.join('; ')}`,
      quarantined: true,
    });
    return;
  }

  // Check for duplicates
  const deduplicationKey = buildDeduplicationKey(
    tenantId,
    extractedFields.claim_id!,
    extractedFields.source_format
  );

  const dynamo = getDynamoClient();
  const existingRecord = await dynamo.send(
    new GetCommand({
      TableName: getTableName(),
      Key: { PK: deduplicationKey.PK, SK: deduplicationKey.SK },
      ProjectionExpression: 'PK, SK',
    })
  );

  if (existingRecord.Item) {
    console.info(
      `[INGESTION] Duplicate detected for claim_id=${extractedFields.claim_id}, ` +
      `source_format=${extractedFields.source_format}. Skipping.`
    );
    result.recordsDuplicate++;
    return;
  }

  // Store valid Denial_Record in DynamoDB
  const denialRecord = buildDenialRecord(tenantId, s3Key, extractedFields);
  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: denialRecord,
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    })
  );

  console.info(
    `[INGESTION] Stored Denial_Record: claim_id=${denialRecord.claim_id}, ` +
    `tenant_id=${tenantId}, source_format=${denialRecord.source_format}`
  );
  result.recordsStored++;
}

// ─── Field Extraction ───────────────────────────────────────────────────────

/**
 * Extracts denial record fields using the appropriate processor.
 */
async function extractFields(
  bucket: string,
  s3Key: string,
  processorType: 'textract' | 'edi'
): Promise<ExtractedFields> {
  if (processorType === 'edi') {
    return extractFieldsFromEDI(bucket, s3Key);
  }
  return extractFieldsFromTextract(bucket, s3Key);
}

/**
 * Extracts fields from an EDI document.
 */
async function extractFieldsFromEDI(bucket: string, s3Key: string): Promise<ExtractedFields> {
  const content = await getObjectContent(bucket, s3Key);
  const parseResult = parseEDI(content);

  if (!parseResult.success) {
    throw new Error(`EDI parsing failed: ${parseResult.errors.join('; ')}`);
  }

  const fields = parseResult.fields;

  if (parseResult.source_format === 'edi_835') {
    const edi835Fields = fields as {
      claim_id: string | null;
      patient_id: string | null;
      payer_id: string | null;
      denial_date: string | null;
      denied_amount: number | null;
      raw_denial_reason_text: string | null;
    };

    return {
      claim_id: edi835Fields.claim_id,
      patient_id: edi835Fields.patient_id,
      payer_id: edi835Fields.payer_id,
      denial_date: edi835Fields.denial_date,
      denied_amount: edi835Fields.denied_amount,
      raw_denial_reason_text: edi835Fields.raw_denial_reason_text,
      source_format: 'edi_835',
    };
  }

  // EDI 277
  const edi277Fields = fields as {
    claim_id: string | null;
    patient_id: string | null;
    payer_id: string | null;
    raw_denial_reason_text: string | null;
  };

  return {
    claim_id: edi277Fields.claim_id,
    patient_id: edi277Fields.patient_id,
    payer_id: edi277Fields.payer_id,
    denial_date: null, // EDI 277 doesn't typically have denial_date
    denied_amount: null, // EDI 277 doesn't have denied_amount
    raw_denial_reason_text: edi277Fields.raw_denial_reason_text,
    source_format: 'edi_277',
  };
}

/**
 * Extracts fields from a document using Textract.
 */
async function extractFieldsFromTextract(bucket: string, s3Key: string): Promise<ExtractedFields> {
  const extension = getFileExtension(s3Key).toLowerCase();
  const format: SupportedFormat = EXTENSION_TO_FORMAT[extension] || 'pdf';

  const result = await processDocument({
    s3Bucket: bucket,
    s3Key,
    format,
  });

  return {
    claim_id: result.claim_id.value,
    patient_id: result.patient_id.value,
    payer_id: result.payer_id.value,
    denial_date: result.denial_date.value,
    denied_amount: result.denied_amount.value,
    raw_denial_reason_text: result.denial_reason.value,
    source_format: format,
  };
}

// ─── Quarantine Logic ───────────────────────────────────────────────────────

/**
 * Moves a failed document to the quarantine prefix in S3.
 * Performs CopyObject + DeleteObject, then sends SNS notification.
 */
async function quarantineDocument(
  bucket: string,
  s3Key: string,
  errorDescription: string,
  fileSize: number
): Promise<void> {
  const s3 = getS3Client();
  const quarantineKey = `${getQuarantinePrefix()}${s3Key}`;

  try {
    // Copy to quarantine prefix
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${encodeURIComponent(s3Key)}`,
        Key: quarantineKey,
        MetadataDirective: 'COPY',
      })
    );

    // Delete original
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      })
    );

    console.info(`[QUARANTINE] Moved ${s3Key} to ${quarantineKey}`);
  } catch (moveError) {
    console.error(`[QUARANTINE] Failed to move ${s3Key} to quarantine:`, moveError);
    // Continue to send notification even if move fails
  }

  // Send SNS notification
  await sendQuarantineNotification(s3Key, errorDescription, fileSize);
}

/**
 * Sends an SNS notification about a quarantined document.
 */
async function sendQuarantineNotification(
  s3Key: string,
  errorDescription: string,
  fileSize: number
): Promise<void> {
  if (!getSnsTopicArn()) {
    console.warn('[NOTIFICATION] SNS_TOPIC_ARN not configured, skipping notification');
    return;
  }

  const sns = getSNSClient();
  const extension = getFileExtension(s3Key);
  const filename = s3Key.split('/').pop() || s3Key;
  const tenantId = extractTenantId(s3Key) || 'unknown';

  const message = {
    event: 'document_quarantined',
    tenant_id: tenantId,
    document: {
      filename,
      s3_key: s3Key,
      file_size_bytes: fileSize,
      source_format: extension || 'unknown',
      upload_timestamp: new Date().toISOString(),
    },
    error: {
      description: errorDescription,
    },
  };

  try {
    await sns.send(
      new PublishCommand({
        TopicArn: getSnsTopicArn(),
        Subject: `[Denial Ingestion] Document Quarantined - ${filename}`,
        Message: JSON.stringify(message, null, 2),
        MessageAttributes: {
          event_type: { DataType: 'String', StringValue: 'document_quarantined' },
          tenant_id: { DataType: 'String', StringValue: tenantId },
        },
      })
    );

    console.info(`[NOTIFICATION] Quarantine notification sent for ${s3Key}`);
  } catch (snsError) {
    console.error(`[NOTIFICATION] Failed to send quarantine notification for ${s3Key}:`, snsError);
  }
}

// ─── DynamoDB Record Building ───────────────────────────────────────────────

/**
 * Builds a complete DenialRecord for storage in DynamoDB.
 */
function buildDenialRecord(
  tenantId: string,
  s3Key: string,
  fields: ExtractedFields
): DenialRecord {
  const claimId = fields.claim_id!;
  const sourceFormat = fields.source_format;
  const now = new Date().toISOString();

  // TTL: 7 years from now (in epoch seconds)
  const ttlDate = new Date();
  ttlDate.setFullYear(ttlDate.getFullYear() + 7);
  const ttl = Math.floor(ttlDate.getTime() / 1000);

  const gsi1Keys = buildGSI1Keys(claimId, tenantId);

  return {
    PK: buildTenantPK(tenantId),
    SK: buildDenialSK(claimId, sourceFormat),
    claim_id: claimId,
    patient_id: fields.patient_id!,
    payer_id: fields.payer_id!,
    tenant_id: tenantId,
    denial_date: fields.denial_date!,
    denied_amount: fields.denied_amount!,
    raw_denial_reason_text: fields.raw_denial_reason_text!,
    source_format: sourceFormat,
    source_s3_key: s3Key,
    ingestion_timestamp: now,
    status: 'ingested',
    workflow_execution_id: '', // Set by Step Functions when workflow starts
    ttl,
    GSI1PK: gsi1Keys.GSI1PK,
    GSI1SK: gsi1Keys.GSI1SK,
  };
}

// ─── S3 Helpers ─────────────────────────────────────────────────────────────

/**
 * Retrieves the full content of an S3 object as a string.
 */
async function getObjectContent(bucket: string, key: string): Promise<string> {
  const s3 = getS3Client();
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );

  if (!response.Body) {
    throw new Error(`Empty response body for s3://${bucket}/${key}`);
  }

  return response.Body.transformToString('utf-8');
}

/**
 * Retrieves the first 1KB of an S3 object for content-type sniffing.
 */
async function getObjectContentSnippet(bucket: string, key: string): Promise<string | null> {
  const s3 = getS3Client();
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: 'bytes=0-1023',
      })
    );

    if (!response.Body) return null;
    return response.Body.transformToString('utf-8');
  } catch {
    return null;
  }
}
