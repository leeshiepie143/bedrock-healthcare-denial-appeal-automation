/**
 * Confidence interval calculation for viability scoring.
 *
 * Implements Wilson score interval at 90% confidence level for estimating
 * the true overturn probability. Widens the interval when historical data
 * is sparse (fewer than 30 outcomes).
 *
 * Queries DynamoDB GSI2 for historical outcome data by (denial_reason, payer).
 */

import { GSI, TABLE_DENIAL_APPEALS } from '@shared/dynamodb';
import type { ConfidenceInterval } from '@shared/models';

// ─── Constants ──────────────────────────────────────────────────────────────

/** z-score for 90% confidence level */
export const Z_SCORE_90 = 1.645;

/** Minimum sample size for standard (non-widened) confidence interval */
export const MIN_SAMPLE_SIZE = 30;

/** Confidence level used for all intervals */
export const CONFIDENCE_LEVEL = 0.90 as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConfidenceResult {
  confidence_interval: ConfidenceInterval;
  limited_historical_data: boolean;
}

export interface HistoricalOutcomes {
  total_outcomes: number;
  overturn_outcomes: number;
  overturn_rate: number;
}

// ─── Pure Math: Wilson Score Interval ───────────────────────────────────────

/**
 * Calculates the Wilson score confidence interval for a proportion.
 *
 * The Wilson score interval provides better coverage than the normal approximation,
 * especially for small sample sizes and extreme proportions.
 *
 * When n = 0, returns the maximally wide interval [0.0, 1.0].
 * When n < 30, applies a widening factor of (30/n) to the margin.
 *
 * @param score - The viability score (point estimate, 0.0–1.0)
 * @param n - Number of historical outcomes
 * @param p - Historical overturn rate (proportion, 0.0–1.0)
 * @returns ConfidenceInterval with lower, upper, and confidence_level
 */
export function calculateWilsonInterval(score: number, n: number, p: number): ConfidenceInterval {
  // Edge case: no historical data → maximally wide interval
  if (n === 0) {
    return {
      lower: 0.0,
      upper: 1.0,
      confidence_level: CONFIDENCE_LEVEL,
    };
  }

  const z = Z_SCORE_90;
  const zSquared = z * z;

  // Wilson score interval formula
  const denominator = 1 + zSquared / n;
  const center = (p + zSquared / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / denominator;

  // Apply widening factor for sparse data (n < 30)
  let adjustedMargin = margin;
  if (n < MIN_SAMPLE_SIZE) {
    adjustedMargin = margin * (MIN_SAMPLE_SIZE / n);
  }

  // Clamp bounds to [0.0, 1.0]
  const lower = Math.max(0.0, center - adjustedMargin);
  const upper = Math.min(1.0, center + adjustedMargin);

  return {
    lower,
    upper,
    confidence_level: CONFIDENCE_LEVEL,
  };
}

// ─── DynamoDB Query: Historical Outcomes ────────────────────────────────────

/**
 * Queries DynamoDB GSI2 for historical outcome data by (payer, denial_reason).
 *
 * GSI2 key structure:
 *   GSI2PK: `${payer_id}#${denial_reason_code}`
 *   GSI2SK: outcome_type (overturn | partial_overturn | upheld)
 *
 * Counts total outcomes and overturn outcomes (overturn + partial_overturn).
 *
 * @param dynamoClient - DynamoDB document client (or mock with send method)
 * @param payerId - The payer identifier
 * @param denialReasonCode - The denial reason code (e.g., CARC code)
 * @param tableName - DynamoDB table name (defaults to DenialAppeals)
 * @returns HistoricalOutcomes with total count, overturn count, and rate
 */
export async function queryHistoricalOutcomes(
  dynamoClient: { send: (command: unknown) => Promise<unknown> },
  payerId: string,
  denialReasonCode: string,
  tableName: string = TABLE_DENIAL_APPEALS,
): Promise<HistoricalOutcomes> {
  const gsi2pk = `${payerId}#${denialReasonCode}`;

  try {
    // Query GSI2 for all outcomes matching this payer + denial reason
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

    const command = new QueryCommand({
      TableName: tableName,
      IndexName: GSI.GSI2,
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: {
        ':pk': gsi2pk,
      },
      Select: 'ALL_ATTRIBUTES',
    });

    const response = await dynamoClient.send(command) as { Items?: Array<{ GSI2SK?: string }> };
    const items = response.Items ?? [];

    const totalOutcomes = items.length;
    const overturnOutcomes = items.filter(
      (item) => item.GSI2SK === 'overturn' || item.GSI2SK === 'partial_overturn',
    ).length;

    const overturnRate = totalOutcomes > 0 ? overturnOutcomes / totalOutcomes : 0;

    return {
      total_outcomes: totalOutcomes,
      overturn_outcomes: overturnOutcomes,
      overturn_rate: overturnRate,
    };
  } catch (error) {
    // On DynamoDB failure, return zero outcomes (will produce maximally wide interval)
    return {
      total_outcomes: 0,
      overturn_outcomes: 0,
      overturn_rate: 0,
    };
  }
}

// ─── Combined Result Builder ────────────────────────────────────────────────

/**
 * Builds the complete confidence result combining the Wilson interval
 * calculation with the limited historical data flag.
 *
 * @param score - The viability score (point estimate, 0.0–1.0)
 * @param n - Number of historical outcomes
 * @param p - Historical overturn rate (proportion, 0.0–1.0)
 * @returns ConfidenceResult with interval and limited_historical_data flag
 */
export function buildConfidenceResult(score: number, n: number, p: number): ConfidenceResult {
  const confidence_interval = calculateWilsonInterval(score, n, p);
  const limited_historical_data = n < MIN_SAMPLE_SIZE;

  return {
    confidence_interval,
    limited_historical_data,
  };
}
