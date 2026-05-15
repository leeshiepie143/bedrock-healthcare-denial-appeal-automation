/**
 * Viability Assessment Handler Lambda
 *
 * Step Functions task handler for the viability assessment step.
 * Orchestrates: historical outcome query → scoring model load → viability scoring
 * → confidence interval calculation → DynamoDB storage.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type {
  ClassifiedDenial,
  DenialRecord,
  EvidencePackage,
  ViabilityAssessment,
} from '@shared/models';
import { buildTenantPK, buildViabilitySK } from '@shared/dynamodb';
import { queryHistoricalOutcomes, buildConfidenceResult } from './confidence';
import {
  loadScoringModel,
  calculateViabilityScore,
  calculateEvidenceScore,
  calculateDaysRemaining,
  clearModelCache,
  type ScoringInput,
} from './scorer';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getDefaultAppealWindowDays(): number {
  const envVal = process.env.DEFAULT_APPEAL_WINDOW_DAYS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 60;
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;
let s3Client: S3Client | null = null;

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

/** Allows injecting mock clients for testing. */
export function setClients(clients: {
  dynamo?: DynamoDBDocumentClient;
  s3?: S3Client;
}): void {
  if (clients.dynamo) dynamoClient = clients.dynamo;
  if (clients.s3) s3Client = clients.s3;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  dynamoClient = null;
  s3Client = null;
  clearModelCache();
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input event from Step Functions — contains evidence, classification, and denial record. */
export interface ViabilityHandlerInput {
  evidencePackage: EvidencePackage;
  classifiedDenial: ClassifiedDenial;
  denialRecord: DenialRecord;
}

/** Result returned by the handler to Step Functions. */
export interface ViabilityHandlerResult {
  viabilityAssessment: ViabilityAssessment;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Step Functions task handler for the viability assessment step.
 *
 * Receives an EvidencePackage, ClassifiedDenial, and DenialRecord from the previous steps,
 * calculates the viability score with confidence interval, stores the assessment in DynamoDB,
 * and returns it for the next step.
 */
export async function handler(event: ViabilityHandlerInput): Promise<ViabilityHandlerResult> {
  const { evidencePackage, classifiedDenial, denialRecord } = event;
  const { claim_id, tenant_id, payer_id, denial_date, denied_amount } = denialRecord;

  console.info(
    `[VIABILITY] Processing claim_id=${claim_id}, tenant_id=${tenant_id}, payer_id=${payer_id}`
  );

  // Determine the primary denial reason code (first CARC code by rank)
  const primaryDenialReasonCode = getPrimaryDenialReasonCode(classifiedDenial);

  // Step 1: Query historical outcomes for this payer + denial reason
  const dynamo = getDynamoClient();
  const historicalOutcomes = await queryHistoricalOutcomes(
    dynamo,
    payer_id,
    primaryDenialReasonCode,
    getTableName()
  );

  console.info(
    `[VIABILITY] Historical outcomes: total=${historicalOutcomes.total_outcomes}, ` +
    `overturn_rate=${historicalOutcomes.overturn_rate.toFixed(3)}`
  );

  // Step 2: Load the scoring model from S3 (or use default)
  const scoringModel = await loadScoringModel(getS3Client());

  // Step 3: Calculate appeal deadline date
  const appealDeadlineDate = calculateAppealDeadline(denial_date);

  // Step 4: Calculate viability score
  const scoringInput: ScoringInput = {
    evidencePackage,
    denialReasonCode: primaryDenialReasonCode,
    payerId: payer_id,
    claimAmount: denied_amount,
    appealDeadlineDate,
    historicalOverturnRate: historicalOutcomes.overturn_rate,
    payerOverturnRate: historicalOutcomes.overturn_rate, // Same source for v1
  };

  const scoringResult = calculateViabilityScore(scoringInput, scoringModel);

  // Step 5: Build confidence interval
  const confidenceResult = buildConfidenceResult(
    scoringResult.score,
    historicalOutcomes.total_outcomes,
    historicalOutcomes.overturn_rate
  );

  // Step 6: Calculate days to deadline for inputs record
  const daysToDeadline = calculateDaysRemaining(appealDeadlineDate);
  const evidenceScore = calculateEvidenceScore(evidencePackage);

  // Step 7: Build the full ViabilityAssessment
  const viabilityAssessment: ViabilityAssessment = {
    PK: buildTenantPK(tenant_id),
    SK: buildViabilitySK(claim_id),
    claim_id,
    viability_score: scoringResult.score,
    confidence_interval: confidenceResult.confidence_interval,
    recommendation: scoringResult.recommendation,
    rationale: scoringResult.rationale,
    top_evidence_items: scoringResult.topEvidenceItems,
    inputs: {
      denial_reason_code: primaryDenialReasonCode,
      payer_id,
      historical_overturn_rate: historicalOutcomes.overturn_rate,
      evidence_score: evidenceScore,
      claim_amount: denied_amount,
      days_to_deadline: daysToDeadline,
    },
    limited_historical_data: confidenceResult.limited_historical_data,
    deadline_expired: scoringResult.deadlineExpired,
    assessed_at: new Date().toISOString(),
  };

  // Step 8: Store assessment in DynamoDB
  await storeViabilityAssessment(viabilityAssessment);

  console.info(
    `[VIABILITY] Assessment complete for claim_id=${claim_id}:`,
    {
      score: scoringResult.score.toFixed(3),
      recommendation: scoringResult.recommendation,
      confidence_interval: `[${confidenceResult.confidence_interval.lower.toFixed(3)}, ${confidenceResult.confidence_interval.upper.toFixed(3)}]`,
      limited_data: confidenceResult.limited_historical_data,
      deadline_expired: scoringResult.deadlineExpired,
      model_version: scoringResult.modelVersion,
    }
  );

  return { viabilityAssessment };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts the primary denial reason code from the classified denial.
 * Uses the first CARC code sorted by rank (lowest rank = highest priority).
 */
function getPrimaryDenialReasonCode(classifiedDenial: ClassifiedDenial): string {
  const carcCodes = classifiedDenial.carc_codes;
  if (!carcCodes || carcCodes.length === 0) {
    return 'UNKNOWN';
  }

  // Sort by rank ascending and take the first
  const sorted = [...carcCodes].sort((a, b) => a.rank - b.rank);
  return sorted[0].code;
}

/**
 * Calculates the appeal deadline date based on denial_date + configurable window.
 * Returns an ISO 8601 date string.
 */
function calculateAppealDeadline(denialDate: string): string {
  const windowDays = getDefaultAppealWindowDays();
  const [year, month, day] = denialDate.split('T')[0].split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + windowDays);
  return date.toISOString().split('T')[0];
}

// ─── DynamoDB Storage ───────────────────────────────────────────────────────

/**
 * Stores the ViabilityAssessment record in DynamoDB.
 */
async function storeViabilityAssessment(assessment: ViabilityAssessment): Promise<void> {
  const dynamo = getDynamoClient();

  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: assessment,
    })
  );

  console.info(
    `[VIABILITY] Stored ViabilityAssessment: PK=${assessment.PK}, SK=${assessment.SK}`
  );
}
