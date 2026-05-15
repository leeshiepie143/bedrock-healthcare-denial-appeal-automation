/**
 * Aggregate Metrics Calculator Lambda
 *
 * Scheduled via EventBridge for 24-hour recalculation cycle.
 * Scans all outcome records and calculates aggregate metrics:
 * - Overall overturn rate
 * - Overturn rate by payer
 * - Overturn rate by denial reason code
 * - Average time to resolution (calendar days)
 * - Total recovered revenue (USD)
 * - Wilson score 95% CI for payer-reason combos with n >= 100
 *
 * Stores metrics in DynamoDB with PK=METRICS, SK=AGGREGATE#<date> (daily snapshot)
 * and a METRICS#LATEST record that always has the most recent calculation.
 *
 * Requirements: 8.3, 8.4
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { AppealOutcome, OutcomeType } from '@shared/models';

// ─── Constants ──────────────────────────────────────────────────────────────

/** z-score for 95% confidence level */
export const Z_SCORE_95 = 1.96;

/** Minimum sample size for Wilson score CI calculation */
export const MIN_SAMPLE_SIZE_FOR_CI = 100;

/** Partition key for metrics records */
export const METRICS_PK = 'METRICS';

/** Sort key prefix for daily aggregate snapshots */
export const AGGREGATE_SK_PREFIX = 'AGGREGATE#';

/** Sort key for the latest metrics record */
export const LATEST_SK = 'LATEST';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WilsonConfidenceInterval {
  lower: number;
  upper: number;
  confidence_level: 0.95;
  sample_size: number;
}

export interface PayerMetrics {
  payer_id: string;
  total_outcomes: number;
  overturn_count: number;
  overturn_rate: number;
}

export interface DenialReasonMetrics {
  denial_reason_code: string;
  total_outcomes: number;
  overturn_count: number;
  overturn_rate: number;
}

export interface PayerReasonMetrics {
  payer_id: string;
  denial_reason_code: string;
  total_outcomes: number;
  overturn_count: number;
  overturn_rate: number;
  confidence_interval: WilsonConfidenceInterval | null;
}

export interface AggregateMetrics {
  overall_overturn_rate: number;
  total_outcomes: number;
  total_overturns: number;
  overturn_rate_by_payer: PayerMetrics[];
  overturn_rate_by_denial_reason: DenialReasonMetrics[];
  overturn_rate_by_payer_reason: PayerReasonMetrics[];
  average_time_to_resolution_days: number;
  total_recovered_revenue_usd: number;
  calculated_at: string;
}

export interface MetricsRecord {
  PK: string;
  SK: string;
  metrics: AggregateMetrics;
}

// ─── Pure Math: Wilson Score Interval (95% CI) ──────────────────────────────

/**
 * Calculates the Wilson score confidence interval at 95% confidence level.
 *
 * The Wilson score interval provides better coverage than the normal approximation,
 * especially for proportions near 0 or 1.
 *
 * @param successes - Number of overturn outcomes (overturn + partial_overturn)
 * @param total - Total number of outcomes
 * @returns WilsonConfidenceInterval or null if total < MIN_SAMPLE_SIZE_FOR_CI
 */
export function calculateWilsonScoreInterval(
  successes: number,
  total: number,
): WilsonConfidenceInterval | null {
  if (total < MIN_SAMPLE_SIZE_FOR_CI) {
    return null;
  }

  const p = successes / total;
  const n = total;
  const z = Z_SCORE_95;
  const zSquared = z * z;

  const denominator = 1 + zSquared / n;
  const center = (p + zSquared / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / denominator;

  const lower = Math.max(0.0, center - margin);
  const upper = Math.min(1.0, center + margin);

  return {
    lower,
    upper,
    confidence_level: 0.95,
    sample_size: total,
  };
}

// ─── Pure Function: Calculate Aggregate Metrics ─────────────────────────────

/**
 * Calculates aggregate metrics from a set of appeal outcome records.
 * This is a pure function exported for testability.
 *
 * @param outcomes - Array of AppealOutcome records
 * @param calculatedAt - ISO 8601 timestamp for when the calculation was performed
 * @returns AggregateMetrics object with all calculated metrics
 */
export function calculateAggregateMetrics(
  outcomes: AppealOutcome[],
  calculatedAt: string,
): AggregateMetrics {
  if (outcomes.length === 0) {
    return {
      overall_overturn_rate: 0,
      total_outcomes: 0,
      total_overturns: 0,
      overturn_rate_by_payer: [],
      overturn_rate_by_denial_reason: [],
      overturn_rate_by_payer_reason: [],
      average_time_to_resolution_days: 0,
      total_recovered_revenue_usd: 0,
      calculated_at: calculatedAt,
    };
  }

  // Overall overturn rate
  const totalOutcomes = outcomes.length;
  const totalOverturns = outcomes.filter(
    (o) => o.outcome_type === 'overturn' || o.outcome_type === 'partial_overturn',
  ).length;
  const overallOverturnRate = totalOverturns / totalOutcomes;

  // Overturn rate by payer
  const byPayer = groupBy(outcomes, (o) => o.payer_id);
  const overturnRateByPayer: PayerMetrics[] = Object.entries(byPayer).map(
    ([payerId, payerOutcomes]) => {
      const overturnCount = payerOutcomes.filter(isOverturn).length;
      return {
        payer_id: payerId,
        total_outcomes: payerOutcomes.length,
        overturn_count: overturnCount,
        overturn_rate: overturnCount / payerOutcomes.length,
      };
    },
  );

  // Overturn rate by denial reason
  const byReason = groupBy(outcomes, (o) => o.denial_reason_code);
  const overturnRateByDenialReason: DenialReasonMetrics[] = Object.entries(byReason).map(
    ([reasonCode, reasonOutcomes]) => {
      const overturnCount = reasonOutcomes.filter(isOverturn).length;
      return {
        denial_reason_code: reasonCode,
        total_outcomes: reasonOutcomes.length,
        overturn_count: overturnCount,
        overturn_rate: overturnCount / reasonOutcomes.length,
      };
    },
  );

  // Overturn rate by payer-reason combination (with Wilson CI when n >= 100)
  const byPayerReason = groupBy(outcomes, (o) => `${o.payer_id}#${o.denial_reason_code}`);
  const overturnRateByPayerReason: PayerReasonMetrics[] = Object.entries(byPayerReason).map(
    ([key, prOutcomes]) => {
      const [payerId, ...reasonParts] = key.split('#');
      const denialReasonCode = reasonParts.join('#');
      const overturnCount = prOutcomes.filter(isOverturn).length;
      const total = prOutcomes.length;
      const ci = calculateWilsonScoreInterval(overturnCount, total);

      return {
        payer_id: payerId,
        denial_reason_code: denialReasonCode,
        total_outcomes: total,
        overturn_count: overturnCount,
        overturn_rate: overturnCount / total,
        confidence_interval: ci,
      };
    },
  );

  // Average time to resolution
  const totalResolutionDays = outcomes.reduce(
    (sum, o) => sum + o.time_to_resolution_days,
    0,
  );
  const averageTimeToResolution = totalResolutionDays / totalOutcomes;

  // Total recovered revenue (only for overturn + partial_overturn)
  const totalRecoveredRevenue = outcomes
    .filter(isOverturn)
    .reduce((sum, o) => sum + o.recovered_amount, 0);

  return {
    overall_overturn_rate: overallOverturnRate,
    total_outcomes: totalOutcomes,
    total_overturns: totalOverturns,
    overturn_rate_by_payer: overturnRateByPayer,
    overturn_rate_by_denial_reason: overturnRateByDenialReason,
    overturn_rate_by_payer_reason: overturnRateByPayerReason,
    average_time_to_resolution_days: averageTimeToResolution,
    total_recovered_revenue_usd: totalRecoveredRevenue,
    calculated_at: calculatedAt,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Checks if an outcome is an overturn (overturn or partial_overturn).
 */
function isOverturn(outcome: AppealOutcome): boolean {
  return outcome.outcome_type === 'overturn' || outcome.outcome_type === 'partial_overturn';
}

/**
 * Groups an array of items by a key function.
 */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  }
  return groups;
}

// ─── DynamoDB Scanning ──────────────────────────────────────────────────────

/**
 * Scans all outcome records from DynamoDB.
 * Uses a filter expression to only return OUTCOME# records.
 */
export async function scanOutcomeRecords(
  dynamoClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<AppealOutcome[]> {
  const outcomes: AppealOutcome[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const command = new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':skPrefix': 'OUTCOME#',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const response = await dynamoClient.send(command);
    const items = (response.Items ?? []) as AppealOutcome[];
    outcomes.push(...items);
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return outcomes;
}

// ─── DynamoDB Storage ───────────────────────────────────────────────────────

/**
 * Stores the metrics record in DynamoDB as both a daily snapshot and the LATEST record.
 */
export async function storeMetrics(
  dynamoClient: DynamoDBDocumentClient,
  tableName: string,
  metrics: AggregateMetrics,
  date: string,
): Promise<void> {
  // Store daily snapshot: PK=METRICS, SK=AGGREGATE#<date>
  const dailyRecord: MetricsRecord = {
    PK: METRICS_PK,
    SK: `${AGGREGATE_SK_PREFIX}${date}`,
    metrics,
  };

  // Store latest: PK=METRICS, SK=LATEST
  const latestRecord: MetricsRecord = {
    PK: METRICS_PK,
    SK: LATEST_SK,
    metrics,
  };

  await Promise.all([
    dynamoClient.send(
      new PutCommand({
        TableName: tableName,
        Item: dailyRecord,
      }),
    ),
    dynamoClient.send(
      new PutCommand({
        TableName: tableName,
        Item: latestRecord,
      }),
    ),
  ]);
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
export function setDynamoClient(client: DynamoDBDocumentClient): void {
  dynamoClient = client;
}

/** Resets the client (useful for testing cleanup). */
export function resetDynamoClient(): void {
  dynamoClient = null;
}

// ─── Lambda Handler (EventBridge Scheduled) ─────────────────────────────────

/**
 * EventBridge scheduled Lambda handler.
 * Runs every 24 hours to recalculate aggregate metrics.
 */
export async function handler(): Promise<void> {
  const tableName = process.env.TABLE_NAME || 'DenialAppeals';
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const calculatedAt = now.toISOString();

  console.info(`[METRICS] Starting aggregate metrics calculation for date=${date}`);

  const client = getDynamoClient();

  // Step 1: Scan all outcome records
  const outcomes = await scanOutcomeRecords(client, tableName);
  console.info(`[METRICS] Found ${outcomes.length} outcome records`);

  // Step 2: Calculate aggregate metrics (pure function)
  const metrics = calculateAggregateMetrics(outcomes, calculatedAt);

  console.info(
    `[METRICS] Calculated metrics:`,
    {
      overall_overturn_rate: metrics.overall_overturn_rate.toFixed(3),
      total_outcomes: metrics.total_outcomes,
      total_overturns: metrics.total_overturns,
      payer_count: metrics.overturn_rate_by_payer.length,
      reason_count: metrics.overturn_rate_by_denial_reason.length,
      payer_reason_combos: metrics.overturn_rate_by_payer_reason.length,
      combos_with_ci: metrics.overturn_rate_by_payer_reason.filter(
        (pr) => pr.confidence_interval !== null,
      ).length,
      avg_resolution_days: metrics.average_time_to_resolution_days.toFixed(1),
      total_recovered_revenue: metrics.total_recovered_revenue_usd.toFixed(2),
    },
  );

  // Step 3: Store metrics in DynamoDB
  await storeMetrics(client, tableName, metrics, date);

  console.info(`[METRICS] Metrics stored successfully for date=${date}`);
}
