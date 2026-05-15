/**
 * Outcome Recorder Lambda
 *
 * API Gateway handler that receives appeal outcome submissions,
 * validates required fields, and stores valid Appeal_Outcome records
 * in DynamoDB with GSI2 keys for payer+reason analytics.
 *
 * Requirements: 8.1, 8.2
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AppealOutcome } from '@shared/models';
import { validateOutcomeFields } from '@shared/validation';
import { buildTenantPK, buildOutcomeSK, buildGSI2Keys } from '@shared/dynamodb';

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

/** Input payload from API Gateway body */
export interface OutcomeRecordInput {
  claim_id?: string;
  outcome_type?: string;
  denial_reason_code?: string;
  payer_id?: string;
  evidence_used?: string[];
  letter_version?: number;
  time_to_resolution_days?: number;
  recovered_amount?: number;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Lambda handler for recording appeal outcomes via API Gateway.
 * Expects tenant ID from x-tenant-id header and outcome data in the request body.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Extract tenant ID from header
  const tenantId = event.headers?.['x-tenant-id'] || event.headers?.['X-Tenant-Id'];
  if (!tenantId) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Missing required header: x-tenant-id',
      }),
    };
  }

  // Parse request body
  let input: OutcomeRecordInput;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Invalid JSON in request body',
      }),
    };
  }

  // Validate required fields
  const validation = validateOutcomeFields({
    denial_reason_code: input.denial_reason_code,
    payer_id: input.payer_id,
    outcome_type: input.outcome_type,
    time_to_resolution_days: input.time_to_resolution_days,
  });

  if (!validation.valid) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Validation failed: missing or invalid required fields',
        missing_fields: validation.errors,
      }),
    };
  }

  // Validate claim_id is present (needed for SK)
  if (!input.claim_id || typeof input.claim_id !== 'string' || input.claim_id.trim().length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Validation failed: missing or invalid required fields',
        missing_fields: ['claim_id is required'],
      }),
    };
  }

  // Build the Appeal_Outcome record
  const now = new Date().toISOString();
  const gsi2Keys = buildGSI2Keys(
    input.payer_id!,
    input.denial_reason_code!,
    input.outcome_type!
  );

  const outcomeRecord: AppealOutcome = {
    PK: buildTenantPK(tenantId),
    SK: buildOutcomeSK(input.claim_id),
    claim_id: input.claim_id,
    outcome_type: input.outcome_type as AppealOutcome['outcome_type'],
    denial_reason_code: input.denial_reason_code!,
    payer_id: input.payer_id!,
    evidence_used: input.evidence_used || [],
    letter_version: input.letter_version || 1,
    time_to_resolution_days: input.time_to_resolution_days!,
    recovered_amount: input.recovered_amount || 0,
    received_at: now,
    GSI2PK: gsi2Keys.GSI2PK,
    GSI2SK: gsi2Keys.GSI2SK,
  };

  // Store in DynamoDB
  const dynamo = getDynamoClient();
  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: outcomeRecord,
    })
  );

  console.info(
    `[OUTCOME_RECORDER] Stored outcome: claim_id=${input.claim_id}, ` +
    `outcome_type=${input.outcome_type}, tenant_id=${tenantId}`
  );

  return {
    statusCode: 201,
    body: JSON.stringify(outcomeRecord),
  };
}
