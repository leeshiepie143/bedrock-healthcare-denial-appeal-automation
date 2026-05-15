/**
 * Unit tests for Aggregate Metrics Calculator
 *
 * Tests the pure calculateAggregateMetrics function, Wilson score interval
 * calculation, DynamoDB scanning, and metrics storage.
 *
 * Requirements: 8.3, 8.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateAggregateMetrics,
  calculateWilsonScoreInterval,
  scanOutcomeRecords,
  storeMetrics,
  Z_SCORE_95,
  MIN_SAMPLE_SIZE_FOR_CI,
  METRICS_PK,
  AGGREGATE_SK_PREFIX,
  LATEST_SK,
} from '@lambdas/outcomes/metrics-calculator';
import type { AppealOutcome } from '@shared/models';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeOutcome(overrides: Partial<AppealOutcome> = {}): AppealOutcome {
  return {
    PK: 'TENANT#tenant-1',
    SK: 'OUTCOME#claim-1',
    claim_id: 'claim-1',
    outcome_type: 'overturn',
    denial_reason_code: 'CO-45',
    payer_id: 'PAYER-A',
    evidence_used: ['fhir-1'],
    letter_version: 1,
    time_to_resolution_days: 30,
    recovered_amount: 5000.0,
    received_at: '2024-01-15T10:00:00Z',
    ...overrides,
  };
}

const CALCULATED_AT = '2024-02-01T00:00:00Z';

// ─── calculateWilsonScoreInterval Tests ─────────────────────────────────────

describe('calculateWilsonScoreInterval', () => {
  it('should return null when total < 100', () => {
    expect(calculateWilsonScoreInterval(30, 99)).toBeNull();
    expect(calculateWilsonScoreInterval(5, 10)).toBeNull();
    expect(calculateWilsonScoreInterval(0, 0)).toBeNull();
  });

  it('should return a confidence interval when total >= 100', () => {
    const result = calculateWilsonScoreInterval(60, 100);
    expect(result).not.toBeNull();
    expect(result!.confidence_level).toBe(0.95);
    expect(result!.sample_size).toBe(100);
  });

  it('should return lower <= upper', () => {
    const result = calculateWilsonScoreInterval(50, 200);
    expect(result).not.toBeNull();
    expect(result!.lower).toBeLessThanOrEqual(result!.upper);
  });

  it('should return bounds in [0.0, 1.0]', () => {
    const result = calculateWilsonScoreInterval(80, 100);
    expect(result).not.toBeNull();
    expect(result!.lower).toBeGreaterThanOrEqual(0.0);
    expect(result!.upper).toBeLessThanOrEqual(1.0);
  });

  it('should produce narrower interval with larger sample size', () => {
    const small = calculateWilsonScoreInterval(50, 100);
    const large = calculateWilsonScoreInterval(500, 1000);
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();

    const smallWidth = small!.upper - small!.lower;
    const largeWidth = large!.upper - large!.lower;
    expect(smallWidth).toBeGreaterThan(largeWidth);
  });

  it('should handle p = 0 (no overturns)', () => {
    const result = calculateWilsonScoreInterval(0, 100);
    expect(result).not.toBeNull();
    expect(result!.lower).toBe(0.0);
    expect(result!.upper).toBeGreaterThan(0.0);
  });

  it('should handle p = 1 (all overturns)', () => {
    const result = calculateWilsonScoreInterval(100, 100);
    expect(result).not.toBeNull();
    expect(result!.lower).toBeLessThan(1.0);
    // Upper bound should be at or very close to 1.0 (clamped)
    expect(result!.upper).toBeCloseTo(1.0, 5);
    expect(result!.upper).toBeLessThanOrEqual(1.0);
  });

  it('should contain the observed proportion within the interval', () => {
    const successes = 65;
    const total = 200;
    const p = successes / total;
    const result = calculateWilsonScoreInterval(successes, total);
    expect(result).not.toBeNull();
    expect(result!.lower).toBeLessThanOrEqual(p);
    expect(result!.upper).toBeGreaterThanOrEqual(p);
  });

  it('should return exactly n=100 boundary', () => {
    const result = calculateWilsonScoreInterval(50, 100);
    expect(result).not.toBeNull();
    expect(result!.sample_size).toBe(100);
  });

  describe('constants', () => {
    it('should use z = 1.96 for 95% confidence', () => {
      expect(Z_SCORE_95).toBe(1.96);
    });

    it('should use 100 as minimum sample size for CI', () => {
      expect(MIN_SAMPLE_SIZE_FOR_CI).toBe(100);
    });
  });
});

// ─── calculateAggregateMetrics Tests ────────────────────────────────────────

describe('calculateAggregateMetrics', () => {
  describe('empty outcomes', () => {
    it('should return zero metrics for empty array', () => {
      const result = calculateAggregateMetrics([], CALCULATED_AT);

      expect(result.overall_overturn_rate).toBe(0);
      expect(result.total_outcomes).toBe(0);
      expect(result.total_overturns).toBe(0);
      expect(result.overturn_rate_by_payer).toEqual([]);
      expect(result.overturn_rate_by_denial_reason).toEqual([]);
      expect(result.overturn_rate_by_payer_reason).toEqual([]);
      expect(result.average_time_to_resolution_days).toBe(0);
      expect(result.total_recovered_revenue_usd).toBe(0);
      expect(result.calculated_at).toBe(CALCULATED_AT);
    });
  });

  describe('overall overturn rate', () => {
    it('should calculate overturn rate as (overturn + partial_overturn) / total', () => {
      const outcomes = [
        makeOutcome({ outcome_type: 'overturn' }),
        makeOutcome({ outcome_type: 'partial_overturn' }),
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);

      expect(result.overall_overturn_rate).toBe(0.5);
      expect(result.total_outcomes).toBe(4);
      expect(result.total_overturns).toBe(2);
    });

    it('should return 1.0 when all outcomes are overturns', () => {
      const outcomes = [
        makeOutcome({ outcome_type: 'overturn' }),
        makeOutcome({ outcome_type: 'partial_overturn' }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);
      expect(result.overall_overturn_rate).toBe(1.0);
    });

    it('should return 0.0 when all outcomes are upheld', () => {
      const outcomes = [
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);
      expect(result.overall_overturn_rate).toBe(0.0);
    });
  });

  describe('overturn rate by payer', () => {
    it('should group outcomes by payer_id and calculate rates', () => {
      const outcomes = [
        makeOutcome({ payer_id: 'PAYER-A', outcome_type: 'overturn' }),
        makeOutcome({ payer_id: 'PAYER-A', outcome_type: 'upheld', recovered_amount: 0 }),
        makeOutcome({ payer_id: 'PAYER-B', outcome_type: 'overturn' }),
        makeOutcome({ payer_id: 'PAYER-B', outcome_type: 'overturn' }),
        makeOutcome({ payer_id: 'PAYER-B', outcome_type: 'upheld', recovered_amount: 0 }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);

      const payerA = result.overturn_rate_by_payer.find((p) => p.payer_id === 'PAYER-A');
      const payerB = result.overturn_rate_by_payer.find((p) => p.payer_id === 'PAYER-B');

      expect(payerA).toBeDefined();
      expect(payerA!.total_outcomes).toBe(2);
      expect(payerA!.overturn_count).toBe(1);
      expect(payerA!.overturn_rate).toBe(0.5);

      expect(payerB).toBeDefined();
      expect(payerB!.total_outcomes).toBe(3);
      expect(payerB!.overturn_count).toBe(2);
      expect(payerB!.overturn_rate).toBeCloseTo(2 / 3);
    });
  });

  describe('overturn rate by denial reason', () => {
    it('should group outcomes by denial_reason_code and calculate rates', () => {
      const outcomes = [
        makeOutcome({ denial_reason_code: 'CO-45', outcome_type: 'overturn' }),
        makeOutcome({ denial_reason_code: 'CO-45', outcome_type: 'upheld', recovered_amount: 0 }),
        makeOutcome({ denial_reason_code: 'CO-16', outcome_type: 'partial_overturn' }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);

      const co45 = result.overturn_rate_by_denial_reason.find(
        (r) => r.denial_reason_code === 'CO-45',
      );
      const co16 = result.overturn_rate_by_denial_reason.find(
        (r) => r.denial_reason_code === 'CO-16',
      );

      expect(co45).toBeDefined();
      expect(co45!.total_outcomes).toBe(2);
      expect(co45!.overturn_count).toBe(1);
      expect(co45!.overturn_rate).toBe(0.5);

      expect(co16).toBeDefined();
      expect(co16!.total_outcomes).toBe(1);
      expect(co16!.overturn_count).toBe(1);
      expect(co16!.overturn_rate).toBe(1.0);
    });
  });

  describe('overturn rate by payer-reason combination', () => {
    it('should group by payer+reason and include CI when n >= 100', () => {
      // Create 100 outcomes for one payer-reason combo
      const outcomes: AppealOutcome[] = [];
      for (let i = 0; i < 60; i++) {
        outcomes.push(
          makeOutcome({
            claim_id: `claim-${i}`,
            payer_id: 'PAYER-X',
            denial_reason_code: 'CO-45',
            outcome_type: 'overturn',
          }),
        );
      }
      for (let i = 60; i < 100; i++) {
        outcomes.push(
          makeOutcome({
            claim_id: `claim-${i}`,
            payer_id: 'PAYER-X',
            denial_reason_code: 'CO-45',
            outcome_type: 'upheld',
            recovered_amount: 0,
          }),
        );
      }

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);

      const payerReason = result.overturn_rate_by_payer_reason.find(
        (pr) => pr.payer_id === 'PAYER-X' && pr.denial_reason_code === 'CO-45',
      );

      expect(payerReason).toBeDefined();
      expect(payerReason!.total_outcomes).toBe(100);
      expect(payerReason!.overturn_count).toBe(60);
      expect(payerReason!.overturn_rate).toBe(0.6);
      expect(payerReason!.confidence_interval).not.toBeNull();
      expect(payerReason!.confidence_interval!.confidence_level).toBe(0.95);
      expect(payerReason!.confidence_interval!.sample_size).toBe(100);
      expect(payerReason!.confidence_interval!.lower).toBeLessThan(0.6);
      expect(payerReason!.confidence_interval!.upper).toBeGreaterThan(0.6);
    });

    it('should return null CI when n < 100', () => {
      const outcomes = [
        makeOutcome({ payer_id: 'PAYER-Y', denial_reason_code: 'CO-16', outcome_type: 'overturn' }),
        makeOutcome({
          payer_id: 'PAYER-Y',
          denial_reason_code: 'CO-16',
          outcome_type: 'upheld',
          recovered_amount: 0,
        }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);

      const payerReason = result.overturn_rate_by_payer_reason.find(
        (pr) => pr.payer_id === 'PAYER-Y' && pr.denial_reason_code === 'CO-16',
      );

      expect(payerReason).toBeDefined();
      expect(payerReason!.confidence_interval).toBeNull();
    });
  });

  describe('average time to resolution', () => {
    it('should calculate mean of time_to_resolution_days', () => {
      const outcomes = [
        makeOutcome({ time_to_resolution_days: 10 }),
        makeOutcome({ time_to_resolution_days: 20 }),
        makeOutcome({ time_to_resolution_days: 30 }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);
      expect(result.average_time_to_resolution_days).toBe(20);
    });

    it('should handle single outcome', () => {
      const outcomes = [makeOutcome({ time_to_resolution_days: 45 })];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);
      expect(result.average_time_to_resolution_days).toBe(45);
    });
  });

  describe('total recovered revenue', () => {
    it('should sum recovered_amount for overturn and partial_overturn only', () => {
      const outcomes = [
        makeOutcome({ outcome_type: 'overturn', recovered_amount: 5000 }),
        makeOutcome({ outcome_type: 'partial_overturn', recovered_amount: 2500 }),
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);
      expect(result.total_recovered_revenue_usd).toBe(7500);
    });

    it('should not include upheld outcomes in revenue even if they have recovered_amount', () => {
      const outcomes = [
        makeOutcome({ outcome_type: 'overturn', recovered_amount: 1000 }),
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 500 }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);
      expect(result.total_recovered_revenue_usd).toBe(1000);
    });

    it('should return 0 when no overturns exist', () => {
      const outcomes = [
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
        makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
      ];

      const result = calculateAggregateMetrics(outcomes, CALCULATED_AT);
      expect(result.total_recovered_revenue_usd).toBe(0);
    });
  });

  describe('calculated_at timestamp', () => {
    it('should include the provided calculated_at timestamp', () => {
      const result = calculateAggregateMetrics(
        [makeOutcome()],
        '2024-03-15T12:00:00Z',
      );
      expect(result.calculated_at).toBe('2024-03-15T12:00:00Z');
    });
  });
});

// ─── scanOutcomeRecords Tests ───────────────────────────────────────────────

describe('scanOutcomeRecords', () => {
  it('should scan with correct filter expression for OUTCOME# prefix', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined }),
    };

    await scanOutcomeRecords(mockClient as any, 'TestTable');

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const command = mockClient.send.mock.calls[0][0];
    expect(command.input.TableName).toBe('TestTable');
    expect(command.input.FilterExpression).toBe('begins_with(SK, :skPrefix)');
    expect(command.input.ExpressionAttributeValues[':skPrefix']).toBe('OUTCOME#');
  });

  it('should paginate through all results', async () => {
    const mockClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [makeOutcome({ claim_id: 'claim-1' })],
          LastEvaluatedKey: { PK: 'TENANT#t1', SK: 'OUTCOME#claim-1' },
        })
        .mockResolvedValueOnce({
          Items: [makeOutcome({ claim_id: 'claim-2' })],
          LastEvaluatedKey: undefined,
        }),
    };

    const results = await scanOutcomeRecords(mockClient as any, 'TestTable');

    expect(mockClient.send).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].claim_id).toBe('claim-1');
    expect(results[1].claim_id).toBe('claim-2');
  });

  it('should pass ExclusiveStartKey for pagination', async () => {
    const lastKey = { PK: 'TENANT#t1', SK: 'OUTCOME#claim-1' };
    const mockClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [makeOutcome()],
          LastEvaluatedKey: lastKey,
        })
        .mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: undefined,
        }),
    };

    await scanOutcomeRecords(mockClient as any, 'TestTable');

    const secondCall = mockClient.send.mock.calls[1][0];
    expect(secondCall.input.ExclusiveStartKey).toEqual(lastKey);
  });

  it('should return empty array when no items found', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({ Items: undefined, LastEvaluatedKey: undefined }),
    };

    const results = await scanOutcomeRecords(mockClient as any, 'TestTable');
    expect(results).toEqual([]);
  });
});

// ─── storeMetrics Tests ─────────────────────────────────────────────────────

describe('storeMetrics', () => {
  it('should store both daily snapshot and LATEST record', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({}),
    };

    const metrics = calculateAggregateMetrics([makeOutcome()], CALCULATED_AT);
    await storeMetrics(mockClient as any, 'TestTable', metrics, '2024-02-01');

    expect(mockClient.send).toHaveBeenCalledTimes(2);

    // Check daily snapshot
    const dailyCall = mockClient.send.mock.calls[0][0];
    expect(dailyCall.input.TableName).toBe('TestTable');
    expect(dailyCall.input.Item.PK).toBe(METRICS_PK);
    expect(dailyCall.input.Item.SK).toBe(`${AGGREGATE_SK_PREFIX}2024-02-01`);
    expect(dailyCall.input.Item.metrics).toEqual(metrics);

    // Check LATEST record
    const latestCall = mockClient.send.mock.calls[1][0];
    expect(latestCall.input.TableName).toBe('TestTable');
    expect(latestCall.input.Item.PK).toBe(METRICS_PK);
    expect(latestCall.input.Item.SK).toBe(LATEST_SK);
    expect(latestCall.input.Item.metrics).toEqual(metrics);
  });

  it('should use correct PK and SK format for daily snapshot', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({}),
    };

    const metrics = calculateAggregateMetrics([], CALCULATED_AT);
    await storeMetrics(mockClient as any, 'MyTable', metrics, '2024-12-25');

    const dailyCall = mockClient.send.mock.calls[0][0];
    expect(dailyCall.input.Item.PK).toBe('METRICS');
    expect(dailyCall.input.Item.SK).toBe('AGGREGATE#2024-12-25');
  });
});
