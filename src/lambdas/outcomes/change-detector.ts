/**
 * Statistical Change Detection Lambda
 *
 * Triggered daily by EventBridge scheduled rule.
 * For each (payer_id, denial_reason_code) combination with >= 30 outcomes
 * in the current period, compares the current overturn rate against the
 * prior 90-day baseline using a chi-squared test.
 *
 * If p < 0.05 (chi-squared > 3.841 for 1 df), generates an SNS alert
 * to the revenue cycle manager within 24 hours of detection.
 *
 * Requirements: 8.6
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getSnsTopicArn(): string {
  return process.env.SNS_TOPIC_ARN || '';
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Chi-squared critical value for 1 degree of freedom at p = 0.05. */
export const CHI_SQUARED_CRITICAL_VALUE = 3.841;

/** Minimum number of outcomes required in the current period to trigger analysis. */
export const MINIMUM_OUTCOMES = 30;

/** Number of days for the baseline period. */
export const BASELINE_DAYS = 90;

/** Number of days for the current analysis period. */
export const CURRENT_PERIOD_DAYS = 30;

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

/** Outcome record shape from DynamoDB scan. */
interface OutcomeRecord {
  PK: string;
  SK: string;
  outcome_type: string;
  denial_reason_code: string;
  payer_id: string;
  received_at: string;
}

/** Chi-squared test result for a payer-reason combination. */
export interface ChiSquaredResult {
  chiSquared: number;
  pValue: number;
  significant: boolean;
}

/** Alert payload for a detected change. */
export interface ChangeAlert {
  payer_id: string;
  denial_reason_code: string;
  current_rate: number;
  baseline_rate: number;
  chi_squared: number;
  p_value: number;
  direction: 'increase' | 'decrease';
  current_period_outcomes: number;
  baseline_period_outcomes: number;
}

/** Result of the change detection run. */
export interface ChangeDetectionResult {
  analyzed_combinations: number;
  alerts_generated: number;
  alerts: ChangeAlert[];
  skipped_insufficient_data: number;
}

// ─── Chi-Squared Calculation (Exported for Testability) ─────────────────────

/**
 * Calculates the chi-squared statistic for a 2x2 contingency table
 * comparing current period overturn rate vs baseline overturn rate.
 *
 * Uses the formula for 2x2 tables:
 *   χ² = n * (ad - bc)² / ((a+b)(c+d)(a+c)(b+d))
 *
 * Where:
 *   a = current_overturn
 *   b = current_upheld
 *   c = baseline_overturn
 *   d = baseline_upheld
 *   n = a + b + c + d
 *
 * @param currentOverturn - Number of overturns in current period
 * @param currentUpheld - Number of upheld in current period
 * @param baselineOverturn - Number of overturns in baseline period
 * @param baselineUpheld - Number of upheld in baseline period
 * @returns Chi-squared test result with statistic, approximate p-value, and significance flag
 */
export function calculateChiSquared(
  currentOverturn: number,
  currentUpheld: number,
  baselineOverturn: number,
  baselineUpheld: number
): ChiSquaredResult {
  const a = currentOverturn;
  const b = currentUpheld;
  const c = baselineOverturn;
  const d = baselineUpheld;
  const n = a + b + c + d;

  // Guard against division by zero
  if (n === 0) {
    return { chiSquared: 0, pValue: 1.0, significant: false };
  }

  const rowSum1 = a + b; // current total
  const rowSum2 = c + d; // baseline total
  const colSum1 = a + c; // total overturns
  const colSum2 = b + d; // total upheld

  // If any marginal total is zero, chi-squared is undefined (no variation)
  if (rowSum1 === 0 || rowSum2 === 0 || colSum1 === 0 || colSum2 === 0) {
    return { chiSquared: 0, pValue: 1.0, significant: false };
  }

  // Chi-squared formula for 2x2 contingency table
  const numerator = n * Math.pow(a * d - b * c, 2);
  const denominator = rowSum1 * rowSum2 * colSum1 * colSum2;

  const chiSquared = numerator / denominator;

  // Approximate p-value using chi-squared distribution with 1 df
  // For our purposes, we only need to know if p < 0.05 (χ² > 3.841)
  const pValue = approximatePValue(chiSquared);

  return {
    chiSquared,
    pValue,
    significant: chiSquared >= CHI_SQUARED_CRITICAL_VALUE,
  };
}

/**
 * Approximates the p-value for a chi-squared statistic with 1 degree of freedom.
 * Uses the survival function approximation: p ≈ erfc(sqrt(χ²/2)) / sqrt(2)
 * This is a reasonable approximation for our threshold-based decision.
 */
function approximatePValue(chiSquared: number): number {
  if (chiSquared <= 0) return 1.0;

  // Use the complementary error function approximation
  // For chi-squared with 1 df: p = 2 * (1 - Φ(sqrt(χ²)))
  // where Φ is the standard normal CDF
  const z = Math.sqrt(chiSquared);
  return 2 * (1 - normalCDF(z));
}

/**
 * Standard normal CDF approximation using the Abramowitz and Stegun formula.
 * Accurate to about 1.5e-7.
 */
function normalCDF(x: number): number {
  if (x < 0) return 1 - normalCDF(-x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * x);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  const poly = a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5;
  const result = 1.0 - poly * Math.exp(-x * x / 2);

  return result;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * EventBridge scheduled handler for daily statistical change detection.
 *
 * Scans all outcomes, groups by (payer_id, denial_reason_code),
 * and runs chi-squared tests comparing current period vs baseline.
 */
export async function handler(): Promise<ChangeDetectionResult> {
  console.info('[CHANGE-DETECTOR] Starting daily statistical change detection');

  const now = new Date();

  // Define time periods
  const currentPeriodStart = new Date(now);
  currentPeriodStart.setUTCDate(currentPeriodStart.getUTCDate() - CURRENT_PERIOD_DAYS);

  const baselineStart = new Date(currentPeriodStart);
  baselineStart.setUTCDate(baselineStart.getUTCDate() - BASELINE_DAYS);

  // Step 1: Query all outcomes from baseline start to now
  const outcomes = await queryOutcomes(baselineStart.toISOString());

  console.info(`[CHANGE-DETECTOR] Retrieved ${outcomes.length} total outcomes for analysis`);

  // Step 2: Group outcomes by (payer_id, denial_reason_code)
  const grouped = groupOutcomes(outcomes, currentPeriodStart.toISOString());

  // Step 3: Analyze each combination
  const alerts: ChangeAlert[] = [];
  let analyzedCombinations = 0;
  let skippedInsufficientData = 0;

  for (const [key, data] of grouped.entries()) {
    // Skip if current period has fewer than minimum outcomes
    if (data.currentTotal < MINIMUM_OUTCOMES) {
      skippedInsufficientData++;
      continue;
    }

    analyzedCombinations++;

    // Skip if baseline has no data (can't compare)
    if (data.baselineTotal === 0) {
      skippedInsufficientData++;
      continue;
    }

    // Run chi-squared test
    const result = calculateChiSquared(
      data.currentOverturn,
      data.currentTotal - data.currentOverturn,
      data.baselineOverturn,
      data.baselineTotal - data.baselineOverturn
    );

    if (result.significant) {
      const currentRate = data.currentOverturn / data.currentTotal;
      const baselineRate = data.baselineOverturn / data.baselineTotal;

      const [payerId, denialReasonCode] = key.split('#');

      const alert: ChangeAlert = {
        payer_id: payerId,
        denial_reason_code: denialReasonCode,
        current_rate: currentRate,
        baseline_rate: baselineRate,
        chi_squared: result.chiSquared,
        p_value: result.pValue,
        direction: currentRate > baselineRate ? 'increase' : 'decrease',
        current_period_outcomes: data.currentTotal,
        baseline_period_outcomes: data.baselineTotal,
      };

      alerts.push(alert);
    }
  }

  // Step 4: Send alerts via SNS
  if (alerts.length > 0) {
    await sendAlerts(alerts);
  }

  console.info(
    `[CHANGE-DETECTOR] Complete. Analyzed ${analyzedCombinations} combinations, ` +
    `generated ${alerts.length} alerts, skipped ${skippedInsufficientData} (insufficient data)`
  );

  return {
    analyzed_combinations: analyzedCombinations,
    alerts_generated: alerts.length,
    alerts,
    skipped_insufficient_data: skippedInsufficientData,
  };
}

// ─── Data Querying ──────────────────────────────────────────────────────────

/**
 * Queries all appeal outcomes received after the given cutoff date.
 */
async function queryOutcomes(cutoffIso: string): Promise<OutcomeRecord[]> {
  const dynamo = getDynamoClient();
  const tableName = getTableName();

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

// ─── Data Grouping ──────────────────────────────────────────────────────────

interface GroupedData {
  currentOverturn: number;
  currentTotal: number;
  baselineOverturn: number;
  baselineTotal: number;
}

/**
 * Groups outcomes by (payer_id, denial_reason_code) and splits into
 * current period vs baseline period.
 */
export function groupOutcomes(
  outcomes: OutcomeRecord[],
  currentPeriodStartIso: string
): Map<string, GroupedData> {
  const grouped = new Map<string, GroupedData>();

  for (const outcome of outcomes) {
    const key = `${outcome.payer_id}#${outcome.denial_reason_code}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        currentOverturn: 0,
        currentTotal: 0,
        baselineOverturn: 0,
        baselineTotal: 0,
      });
    }

    const data = grouped.get(key)!;
    const isOverturn = outcome.outcome_type === 'overturn' || outcome.outcome_type === 'partial_overturn';

    if (outcome.received_at >= currentPeriodStartIso) {
      data.currentTotal++;
      if (isOverturn) data.currentOverturn++;
    } else {
      data.baselineTotal++;
      if (isOverturn) data.baselineOverturn++;
    }
  }

  return grouped;
}

// ─── Alert Sending ──────────────────────────────────────────────────────────

/**
 * Sends change detection alerts via SNS.
 */
async function sendAlerts(alerts: ChangeAlert[]): Promise<void> {
  const topicArn = getSnsTopicArn();
  if (!topicArn) {
    console.warn('[CHANGE-DETECTOR] SNS_TOPIC_ARN not configured. Skipping alert delivery.');
    return;
  }

  const sns = getSnsClient();

  for (const alert of alerts) {
    const message = formatAlertMessage(alert);

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `[ALERT] Overturn Rate Change Detected: ${alert.payer_id} / ${alert.denial_reason_code}`,
        Message: message,
        MessageAttributes: {
          alert_type: { DataType: 'String', StringValue: 'overturn_rate_change' },
          payer_id: { DataType: 'String', StringValue: alert.payer_id },
          denial_reason_code: { DataType: 'String', StringValue: alert.denial_reason_code },
          direction: { DataType: 'String', StringValue: alert.direction },
        },
      })
    );

    console.info(
      `[CHANGE-DETECTOR] Alert sent for ${alert.payer_id}#${alert.denial_reason_code}: ` +
      `${alert.direction} from ${(alert.baseline_rate * 100).toFixed(1)}% to ${(alert.current_rate * 100).toFixed(1)}%`
    );
  }
}

/**
 * Formats an alert message for SNS delivery.
 */
function formatAlertMessage(alert: ChangeAlert): string {
  return [
    'Statistical Change Detected in Appeal Overturn Rate',
    '',
    `Payer ID: ${alert.payer_id}`,
    `Denial Reason Code: ${alert.denial_reason_code}`,
    `Direction: ${alert.direction.toUpperCase()}`,
    '',
    `Current Period Rate: ${(alert.current_rate * 100).toFixed(1)}% (n=${alert.current_period_outcomes})`,
    `Baseline Rate (90-day): ${(alert.baseline_rate * 100).toFixed(1)}% (n=${alert.baseline_period_outcomes})`,
    `Change: ${alert.direction === 'increase' ? '+' : ''}${((alert.current_rate - alert.baseline_rate) * 100).toFixed(1)} percentage points`,
    '',
    `Chi-Squared Statistic: ${alert.chi_squared.toFixed(4)}`,
    `P-Value: ${alert.p_value.toFixed(6)}`,
    `Significance: p < 0.05 (critical value = ${CHI_SQUARED_CRITICAL_VALUE})`,
    '',
    'Action Required: Review this payer-reason combination for potential process or policy changes.',
  ].join('\n');
}
