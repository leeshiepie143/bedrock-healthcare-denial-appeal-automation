/**
 * Monthly Report Generation Lambda
 *
 * Triggered on the 1st of each month by EventBridge scheduled rule.
 * Generates a comprehensive monthly report covering the prior calendar month,
 * stores it in DynamoDB, and sends an SNS notification with the summary.
 *
 * Report sections:
 * 1. Performance summary: total appeals, overturn rate, recovered revenue, avg resolution time
 * 2. Volume changes: denial reasons with >= 20% increase in volume vs prior month
 * 3. Payer changes: payers whose overturn rate changed by >= 10 percentage points
 *
 * Requirements: 8.5
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getSnsTopicArn(): string {
  return process.env.SNS_TOPIC_ARN || '';
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum volume change percentage to flag a denial reason. */
export const VOLUME_CHANGE_THRESHOLD = 0.20; // 20%

/** Minimum overturn rate change in percentage points to flag a payer. */
export const PAYER_RATE_CHANGE_THRESHOLD = 0.10; // 10 percentage points

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
  recovered_amount: number;
  time_to_resolution_days: number;
  received_at: string;
}

/** Performance summary section of the monthly report. */
export interface PerformanceSummary {
  total_appeals: number;
  overturn_count: number;
  overturn_rate: number;
  total_recovered_revenue: number;
  average_resolution_time_days: number;
}

/** A denial reason with significant volume change. */
export interface VolumeChange {
  denial_reason_code: string;
  current_month_volume: number;
  prior_month_volume: number;
  change_percentage: number;
}

/** A payer with significant overturn rate change. */
export interface PayerChange {
  payer_id: string;
  current_month_rate: number;
  prior_month_rate: number;
  change_percentage_points: number;
  current_month_outcomes: number;
  prior_month_outcomes: number;
}

/** The complete monthly report structure. */
export interface MonthlyReport {
  PK: string; // REPORT
  SK: string; // MONTHLY#<YYYY-MM>
  report_month: string; // YYYY-MM
  generated_at: string; // ISO 8601
  performance_summary: PerformanceSummary;
  volume_changes: VolumeChange[];
  payer_changes: PayerChange[];
}

/** Result of the monthly report generation. */
export interface MonthlyReportResult {
  report_month: string;
  stored: boolean;
  notified: boolean;
  performance_summary: PerformanceSummary;
  volume_changes_count: number;
  payer_changes_count: number;
}

// ─── Report Calculation Functions (Exported for Testability) ─────────────────

/**
 * Calculates the performance summary for a set of outcomes.
 */
export function calculatePerformanceSummary(outcomes: OutcomeRecord[]): PerformanceSummary {
  if (outcomes.length === 0) {
    return {
      total_appeals: 0,
      overturn_count: 0,
      overturn_rate: 0,
      total_recovered_revenue: 0,
      average_resolution_time_days: 0,
    };
  }

  const overturnOutcomes = outcomes.filter(
    (o) => o.outcome_type === 'overturn' || o.outcome_type === 'partial_overturn'
  );

  const totalRecoveredRevenue = outcomes.reduce(
    (sum, o) => sum + (o.recovered_amount || 0),
    0
  );

  const totalResolutionTime = outcomes.reduce(
    (sum, o) => sum + (o.time_to_resolution_days || 0),
    0
  );

  return {
    total_appeals: outcomes.length,
    overturn_count: overturnOutcomes.length,
    overturn_rate: overturnOutcomes.length / outcomes.length,
    total_recovered_revenue: Math.round(totalRecoveredRevenue * 100) / 100,
    average_resolution_time_days: Math.round((totalResolutionTime / outcomes.length) * 10) / 10,
  };
}

/**
 * Identifies denial reasons with >= 20% increase in volume compared to prior month.
 */
export function calculateVolumeChanges(
  currentMonthOutcomes: OutcomeRecord[],
  priorMonthOutcomes: OutcomeRecord[]
): VolumeChange[] {
  // Count volume by denial_reason_code for each month
  const currentVolume = countByField(currentMonthOutcomes, 'denial_reason_code');
  const priorVolume = countByField(priorMonthOutcomes, 'denial_reason_code');

  const changes: VolumeChange[] = [];

  for (const [code, currentCount] of currentVolume.entries()) {
    const priorCount = priorVolume.get(code) || 0;

    // Only flag increases; skip if prior month had zero (new denial reason)
    if (priorCount === 0) continue;

    const changePercentage = (currentCount - priorCount) / priorCount;

    if (changePercentage >= VOLUME_CHANGE_THRESHOLD) {
      changes.push({
        denial_reason_code: code,
        current_month_volume: currentCount,
        prior_month_volume: priorCount,
        change_percentage: changePercentage,
      });
    }
  }

  // Sort by change percentage descending
  changes.sort((a, b) => b.change_percentage - a.change_percentage);

  return changes;
}

/**
 * Identifies payers whose overturn rate changed by >= 10 percentage points.
 */
export function calculatePayerChanges(
  currentMonthOutcomes: OutcomeRecord[],
  priorMonthOutcomes: OutcomeRecord[]
): PayerChange[] {
  // Calculate overturn rate by payer for each month
  const currentRates = calculateOverturnRateByField(currentMonthOutcomes, 'payer_id');
  const priorRates = calculateOverturnRateByField(priorMonthOutcomes, 'payer_id');

  const changes: PayerChange[] = [];

  for (const [payerId, currentData] of currentRates.entries()) {
    const priorData = priorRates.get(payerId);

    // Skip if payer wasn't present in prior month
    if (!priorData) continue;

    const changePoints = Math.abs(currentData.rate - priorData.rate);

    if (changePoints >= PAYER_RATE_CHANGE_THRESHOLD) {
      changes.push({
        payer_id: payerId,
        current_month_rate: currentData.rate,
        prior_month_rate: priorData.rate,
        change_percentage_points: currentData.rate - priorData.rate,
        current_month_outcomes: currentData.total,
        prior_month_outcomes: priorData.total,
      });
    }
  }

  // Sort by absolute change descending
  changes.sort((a, b) => Math.abs(b.change_percentage_points) - Math.abs(a.change_percentage_points));

  return changes;
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Counts outcomes by a given field.
 */
function countByField(outcomes: OutcomeRecord[], field: keyof OutcomeRecord): Map<string, number> {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    const value = outcome[field] as string;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

/**
 * Calculates overturn rate by a given field.
 */
function calculateOverturnRateByField(
  outcomes: OutcomeRecord[],
  field: keyof OutcomeRecord
): Map<string, { rate: number; total: number }> {
  const groups = new Map<string, { overturns: number; total: number }>();

  for (const outcome of outcomes) {
    const value = outcome[field] as string;
    if (!groups.has(value)) {
      groups.set(value, { overturns: 0, total: 0 });
    }
    const group = groups.get(value)!;
    group.total++;
    if (outcome.outcome_type === 'overturn' || outcome.outcome_type === 'partial_overturn') {
      group.overturns++;
    }
  }

  const rates = new Map<string, { rate: number; total: number }>();
  for (const [key, data] of groups.entries()) {
    rates.set(key, {
      rate: data.total > 0 ? data.overturns / data.total : 0,
      total: data.total,
    });
  }

  return rates;
}

/**
 * Gets the start and end dates for a given month (prior to the reference date).
 * Returns ISO strings for the first and last moment of the month.
 */
export function getMonthBounds(year: number, month: number): { start: string; end: string } {
  // month is 0-indexed (0 = January)
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1)); // First day of next month
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * EventBridge scheduled handler for monthly report generation.
 * Runs on the 1st of each month, covering the prior calendar month.
 */
export async function handler(): Promise<MonthlyReportResult> {
  const now = new Date();

  // Determine the prior month
  const reportYear = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const reportMonth = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1; // 0-indexed

  const reportMonthStr = `${reportYear}-${String(reportMonth + 1).padStart(2, '0')}`;

  console.info(`[MONTHLY-REPORT] Generating report for ${reportMonthStr}`);

  // Get month bounds for current and prior months
  const currentMonthBounds = getMonthBounds(reportYear, reportMonth);

  // Prior month (the month before the report month)
  const priorYear = reportMonth === 0 ? reportYear - 1 : reportYear;
  const priorMonth = reportMonth === 0 ? 11 : reportMonth - 1;
  const priorMonthBounds = getMonthBounds(priorYear, priorMonth);

  // Step 1: Query outcomes for both months
  const allOutcomes = await queryOutcomesInRange(priorMonthBounds.start, currentMonthBounds.end);

  // Split into current and prior month
  const currentMonthOutcomes = allOutcomes.filter(
    (o) => o.received_at >= currentMonthBounds.start && o.received_at < currentMonthBounds.end
  );
  const priorMonthOutcomes = allOutcomes.filter(
    (o) => o.received_at >= priorMonthBounds.start && o.received_at < priorMonthBounds.end
  );

  console.info(
    `[MONTHLY-REPORT] Outcomes: current month=${currentMonthOutcomes.length}, prior month=${priorMonthOutcomes.length}`
  );

  // Step 2: Calculate report sections
  const performanceSummary = calculatePerformanceSummary(currentMonthOutcomes);
  const volumeChanges = calculateVolumeChanges(currentMonthOutcomes, priorMonthOutcomes);
  const payerChanges = calculatePayerChanges(currentMonthOutcomes, priorMonthOutcomes);

  // Step 3: Build and store report
  const report: MonthlyReport = {
    PK: 'REPORT',
    SK: `MONTHLY#${reportMonthStr}`,
    report_month: reportMonthStr,
    generated_at: now.toISOString(),
    performance_summary: performanceSummary,
    volume_changes: volumeChanges,
    payer_changes: payerChanges,
  };

  const stored = await storeReport(report);

  // Step 4: Send SNS notification
  const notified = await sendReportNotification(report);

  console.info(
    `[MONTHLY-REPORT] Report generated for ${reportMonthStr}: ` +
    `${performanceSummary.total_appeals} appeals, ` +
    `${volumeChanges.length} volume changes, ` +
    `${payerChanges.length} payer changes`
  );

  return {
    report_month: reportMonthStr,
    stored,
    notified,
    performance_summary: performanceSummary,
    volume_changes_count: volumeChanges.length,
    payer_changes_count: payerChanges.length,
  };
}

// ─── Data Querying ──────────────────────────────────────────────────────────

/**
 * Queries all appeal outcomes within a date range.
 */
async function queryOutcomesInRange(startIso: string, endIso: string): Promise<OutcomeRecord[]> {
  const dynamo = getDynamoClient();
  const tableName = getTableName();

  const outcomes: OutcomeRecord[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(SK, :skPrefix) AND received_at >= :start AND received_at < :end',
        ExpressionAttributeValues: {
          ':skPrefix': 'OUTCOME#',
          ':start': startIso,
          ':end': endIso,
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

// ─── Report Storage ─────────────────────────────────────────────────────────

/**
 * Stores the monthly report in DynamoDB.
 */
async function storeReport(report: MonthlyReport): Promise<boolean> {
  try {
    const dynamo = getDynamoClient();
    await dynamo.send(
      new PutCommand({
        TableName: getTableName(),
        Item: report,
      })
    );
    console.info(`[MONTHLY-REPORT] Stored report: PK=${report.PK}, SK=${report.SK}`);
    return true;
  } catch (error) {
    console.error('[MONTHLY-REPORT] Failed to store report:', error);
    return false;
  }
}

// ─── Notification ───────────────────────────────────────────────────────────

/**
 * Sends an SNS notification with the report summary.
 */
async function sendReportNotification(report: MonthlyReport): Promise<boolean> {
  const topicArn = getSnsTopicArn();
  if (!topicArn) {
    console.warn('[MONTHLY-REPORT] SNS_TOPIC_ARN not configured. Skipping notification.');
    return false;
  }

  try {
    const sns = getSnsClient();
    const message = formatReportNotification(report);

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `Monthly Appeal Performance Report: ${report.report_month}`,
        Message: message,
        MessageAttributes: {
          report_type: { DataType: 'String', StringValue: 'monthly_performance' },
          report_month: { DataType: 'String', StringValue: report.report_month },
        },
      })
    );

    console.info(`[MONTHLY-REPORT] Notification sent for ${report.report_month}`);
    return true;
  } catch (error) {
    console.error('[MONTHLY-REPORT] Failed to send notification:', error);
    return false;
  }
}

/**
 * Formats the report notification message.
 */
function formatReportNotification(report: MonthlyReport): string {
  const { performance_summary, volume_changes, payer_changes } = report;

  const lines: string[] = [
    `Monthly Appeal Performance Report: ${report.report_month}`,
    '='.repeat(50),
    '',
    'PERFORMANCE SUMMARY',
    '-'.repeat(30),
    `Total Appeals: ${performance_summary.total_appeals}`,
    `Overturn Rate: ${(performance_summary.overturn_rate * 100).toFixed(1)}% (${performance_summary.overturn_count}/${performance_summary.total_appeals})`,
    `Total Recovered Revenue: $${performance_summary.total_recovered_revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `Average Resolution Time: ${performance_summary.average_resolution_time_days} days`,
  ];

  if (volume_changes.length > 0) {
    lines.push('', 'VOLUME CHANGES (>= 20% increase)', '-'.repeat(30));
    for (const change of volume_changes) {
      lines.push(
        `  ${change.denial_reason_code}: ${change.prior_month_volume} → ${change.current_month_volume} (+${(change.change_percentage * 100).toFixed(0)}%)`
      );
    }
  }

  if (payer_changes.length > 0) {
    lines.push('', 'PAYER OVERTURN RATE CHANGES (>= 10pp)', '-'.repeat(30));
    for (const change of payer_changes) {
      const sign = change.change_percentage_points >= 0 ? '+' : '';
      lines.push(
        `  ${change.payer_id}: ${(change.prior_month_rate * 100).toFixed(1)}% → ${(change.current_month_rate * 100).toFixed(1)}% (${sign}${(change.change_percentage_points * 100).toFixed(1)}pp)`
      );
    }
  }

  lines.push('', `Report generated: ${report.generated_at}`);

  return lines.join('\n');
}
