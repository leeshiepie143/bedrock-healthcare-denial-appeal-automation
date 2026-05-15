/**
 * Viability Model Recalibration Lambda
 *
 * Triggered monthly by EventBridge scheduled rule.
 * Queries all appeal outcomes from the last 90 days and recalibrates
 * the scoring model based on observed accuracy.
 *
 * For v1: updates the `last_calibrated` timestamp and adjusts the
 * `historical_overturn_rate` weight based on observed accuracy.
 *
 * Requirements: 4.5
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DEFAULT_SCORING_MODEL, type ScoringModel } from './scorer';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getModelBucket(): string {
  return process.env.MODEL_BUCKET || '';
}

function getModelKey(): string {
  return process.env.MODEL_KEY || '';
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
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Outcome record shape from DynamoDB scan (subset of AppealOutcome). */
interface OutcomeRecord {
  SK: string;
  outcome_type: string;
  denial_reason_code: string;
  payer_id: string;
  received_at: string;
}

/** Result of the recalibration process. */
export interface RecalibrationResult {
  recalibrated: boolean;
  reason: string;
  outcomesAnalyzed: number;
  overturnRate: number;
  modelVersion: string;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * EventBridge scheduled handler for monthly model recalibration.
 *
 * Queries all outcomes from the last 90 days. If >= 30 outcomes exist,
 * recalculates model coefficients and stores the updated model to S3.
 */
export async function handler(): Promise<RecalibrationResult> {
  console.info('[RECALIBRATE] Starting monthly model recalibration');

  // Step 1: Query outcomes from the last 90 days
  const outcomes = await queryRecentOutcomes(90);

  console.info(`[RECALIBRATE] Found ${outcomes.length} outcomes in the last 90 days`);

  // Step 2: Check minimum threshold
  if (outcomes.length < 30) {
    console.info(
      `[RECALIBRATE] Insufficient outcomes (${outcomes.length} < 30). Skipping recalibration.`
    );
    return {
      recalibrated: false,
      reason: `Insufficient outcomes: ${outcomes.length} found, minimum 30 required`,
      outcomesAnalyzed: outcomes.length,
      overturnRate: 0,
      modelVersion: DEFAULT_SCORING_MODEL.version,
    };
  }

  // Step 3: Calculate observed overturn rate
  const overturnCount = outcomes.filter(
    (o) => o.outcome_type === 'overturn' || o.outcome_type === 'partial_overturn'
  ).length;
  const observedOverturnRate = overturnCount / outcomes.length;

  console.info(
    `[RECALIBRATE] Observed overturn rate: ${observedOverturnRate.toFixed(3)} ` +
    `(${overturnCount}/${outcomes.length})`
  );

  // Step 4: Load current model (or use default)
  const currentModel = await loadCurrentModel();

  // Step 5: Recalibrate the model
  const updatedModel = recalibrateModel(currentModel, observedOverturnRate, outcomes.length);

  // Step 6: Store updated model to S3
  await storeModel(updatedModel);

  console.info(
    `[RECALIBRATE] Recalibration complete. New model version: ${updatedModel.version}`
  );

  return {
    recalibrated: true,
    reason: 'Successfully recalibrated with recent outcome data',
    outcomesAnalyzed: outcomes.length,
    overturnRate: observedOverturnRate,
    modelVersion: updatedModel.version,
  };
}

// ─── Outcome Query ──────────────────────────────────────────────────────────

/**
 * Queries all appeal outcomes from the last N days using a DynamoDB scan
 * with a filter on the SK prefix (OUTCOME#) and received_at date.
 */
async function queryRecentOutcomes(days: number): Promise<OutcomeRecord[]> {
  const dynamo = getDynamoClient();
  const tableName = getTableName();

  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
  const cutoffIso = cutoffDate.toISOString();

  const outcomes: OutcomeRecord[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(SK, :skPrefix) AND received_at >= :cutoff',
        ExpressionAttributeValues: {
          ':skPrefix': 'OUTCOME#',
          ':cutoff': cutoffIso,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    ) as { Items?: OutcomeRecord[]; LastEvaluatedKey?: Record<string, unknown> };

    if (response.Items) {
      outcomes.push(...response.Items);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return outcomes;
}

// ─── Model Loading ──────────────────────────────────────────────────────────

/**
 * Loads the current scoring model from S3. Falls back to default if not found.
 */
async function loadCurrentModel(): Promise<ScoringModel> {
  const bucket = getModelBucket();
  const key = getModelKey();

  if (!bucket || !key) {
    return { ...DEFAULT_SCORING_MODEL };
  }

  try {
    const s3 = getS3Client();
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    const body = await response.Body?.transformToString();
    if (!body) {
      return { ...DEFAULT_SCORING_MODEL };
    }

    const model = JSON.parse(body) as ScoringModel;
    if (!model.weights || !model.thresholds || !model.version) {
      return { ...DEFAULT_SCORING_MODEL };
    }

    return model;
  } catch {
    return { ...DEFAULT_SCORING_MODEL };
  }
}

// ─── Model Recalibration ────────────────────────────────────────────────────

/**
 * Recalibrates the scoring model based on observed outcomes.
 *
 * For v1, this performs a simple adjustment:
 * - Updates the `last_calibrated` timestamp
 * - Adjusts the `historical_overturn_rate` weight based on observed accuracy:
 *   - If observed overturn rate is high (> 0.5), increase the weight slightly
 *   - If observed overturn rate is low (< 0.3), decrease the weight slightly
 *   - Keeps weights normalized (sum to 1.0)
 * - Bumps the patch version
 */
export function recalibrateModel(
  currentModel: ScoringModel,
  observedOverturnRate: number,
  sampleSize: number
): ScoringModel {
  const weights = { ...currentModel.weights };

  // Calculate adjustment factor based on observed accuracy
  // Higher sample sizes give more confidence in the adjustment
  const confidenceFactor = Math.min(sampleSize / 100, 1.0);
  let adjustment = 0;

  if (observedOverturnRate > 0.5) {
    // Historical rate is a strong predictor — increase its weight
    adjustment = 0.05 * confidenceFactor;
  } else if (observedOverturnRate < 0.3) {
    // Historical rate is a weak predictor — decrease its weight
    adjustment = -0.05 * confidenceFactor;
  }

  // Apply adjustment to historical_overturn_rate weight
  weights.historical_overturn_rate = Math.max(
    0.1,
    Math.min(0.5, weights.historical_overturn_rate + adjustment)
  );

  // Normalize remaining weights to sum to 1.0
  const otherWeightsSum =
    weights.evidence_score +
    weights.days_remaining_factor +
    weights.claim_amount_factor +
    weights.payer_overturn_rate;

  const targetOtherSum = 1.0 - weights.historical_overturn_rate;
  const scaleFactor = targetOtherSum / otherWeightsSum;

  weights.evidence_score *= scaleFactor;
  weights.days_remaining_factor *= scaleFactor;
  weights.claim_amount_factor *= scaleFactor;
  weights.payer_overturn_rate *= scaleFactor;

  // Bump version
  const versionParts = currentModel.version.split('.').map(Number);
  versionParts[2] = (versionParts[2] || 0) + 1;
  const newVersion = versionParts.join('.');

  return {
    weights,
    thresholds: { ...currentModel.thresholds },
    version: newVersion,
    last_calibrated: new Date().toISOString(),
  };
}

// ─── Model Storage ──────────────────────────────────────────────────────────

/**
 * Stores the updated scoring model to S3.
 */
async function storeModel(model: ScoringModel): Promise<void> {
  const bucket = getModelBucket();
  const key = getModelKey();

  if (!bucket || !key) {
    console.warn('[RECALIBRATE] MODEL_BUCKET or MODEL_KEY not configured. Skipping S3 storage.');
    return;
  }

  const s3 = getS3Client();

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(model, null, 2),
      ContentType: 'application/json',
    })
  );

  console.info(`[RECALIBRATE] Stored updated model to s3://${bucket}/${key}`);
}
