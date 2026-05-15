/**
 * Unit tests for Confidence Interval Calculation
 *
 * Tests Wilson score interval calculation, DynamoDB GSI2 querying for
 * historical outcomes, confidence interval widening for sparse data,
 * and the combined result builder.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  calculateWilsonInterval,
  queryHistoricalOutcomes,
  buildConfidenceResult,
  Z_SCORE_90,
  MIN_SAMPLE_SIZE,
  CONFIDENCE_LEVEL,
} from '@lambdas/viability/confidence';

// ─── calculateWilsonInterval Tests ──────────────────────────────────────────

describe('calculateWilsonInterval', () => {
  describe('basic properties', () => {
    it('should return confidence_level of 0.90', () => {
      const result = calculateWilsonInterval(0.5, 100, 0.5);
      expect(result.confidence_level).toBe(0.90);
    });

    it('should return lower <= upper', () => {
      const result = calculateWilsonInterval(0.7, 50, 0.6);
      expect(result.lower).toBeLessThanOrEqual(result.upper);
    });

    it('should return bounds in [0.0, 1.0]', () => {
      const result = calculateWilsonInterval(0.8, 100, 0.75);
      expect(result.lower).toBeGreaterThanOrEqual(0.0);
      expect(result.upper).toBeLessThanOrEqual(1.0);
    });

    it('should clamp lower bound to 0.0 when calculation goes negative', () => {
      // Very low p with small n can push lower bound below 0
      const result = calculateWilsonInterval(0.01, 5, 0.01);
      expect(result.lower).toBe(0.0);
    });

    it('should clamp upper bound to 1.0 when calculation exceeds 1', () => {
      // Very high p with small n and widening can push upper above 1
      const result = calculateWilsonInterval(0.99, 3, 0.99);
      expect(result.upper).toBe(1.0);
    });
  });

  describe('n = 0 (no historical data)', () => {
    it('should return maximally wide interval [0.0, 1.0]', () => {
      const result = calculateWilsonInterval(0.5, 0, 0);
      expect(result.lower).toBe(0.0);
      expect(result.upper).toBe(1.0);
      expect(result.confidence_level).toBe(0.90);
    });

    it('should return [0.0, 1.0] regardless of score', () => {
      const result = calculateWilsonInterval(0.9, 0, 0);
      expect(result.lower).toBe(0.0);
      expect(result.upper).toBe(1.0);
    });
  });

  describe('n < 30 (sparse data, widened interval)', () => {
    it('should produce a wider interval than n >= 30 for same p', () => {
      const sparse = calculateWilsonInterval(0.5, 10, 0.5);
      const adequate = calculateWilsonInterval(0.5, 50, 0.5);

      const sparseWidth = sparse.upper - sparse.lower;
      const adequateWidth = adequate.upper - adequate.lower;

      expect(sparseWidth).toBeGreaterThan(adequateWidth);
    });

    it('should apply widening factor of 30/n', () => {
      // With n=15, widening factor is 30/15 = 2x
      const n = 15;
      const p = 0.5;
      const z = Z_SCORE_90;
      const zSquared = z * z;

      const denominator = 1 + zSquared / n;
      const center = (p + zSquared / (2 * n)) / denominator;
      const baseMargin = (z * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / denominator;
      const widenedMargin = baseMargin * (30 / n);

      const result = calculateWilsonInterval(0.5, n, p);

      const expectedLower = Math.max(0.0, center - widenedMargin);
      const expectedUpper = Math.min(1.0, center + widenedMargin);

      expect(result.lower).toBeCloseTo(expectedLower, 10);
      expect(result.upper).toBeCloseTo(expectedUpper, 10);
    });

    it('should produce wider interval as n decreases', () => {
      const n5 = calculateWilsonInterval(0.5, 5, 0.5);
      const n15 = calculateWilsonInterval(0.5, 15, 0.5);
      const n29 = calculateWilsonInterval(0.5, 29, 0.5);

      const width5 = n5.upper - n5.lower;
      const width15 = n15.upper - n15.lower;
      const width29 = n29.upper - n29.lower;

      expect(width5).toBeGreaterThan(width15);
      expect(width15).toBeGreaterThan(width29);
    });

    it('should handle n = 1 without error', () => {
      const result = calculateWilsonInterval(0.5, 1, 1.0);
      expect(result.lower).toBeGreaterThanOrEqual(0.0);
      expect(result.upper).toBeLessThanOrEqual(1.0);
      expect(result.confidence_level).toBe(0.90);
    });
  });

  describe('n >= 30 (standard interval)', () => {
    it('should produce standard Wilson interval without widening', () => {
      const n = 100;
      const p = 0.6;
      const z = Z_SCORE_90;
      const zSquared = z * z;

      const denominator = 1 + zSquared / n;
      const center = (p + zSquared / (2 * n)) / denominator;
      const margin = (z * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / denominator;

      const result = calculateWilsonInterval(0.6, n, p);

      expect(result.lower).toBeCloseTo(center - margin, 10);
      expect(result.upper).toBeCloseTo(center + margin, 10);
    });

    it('should produce narrower interval with larger n', () => {
      const n30 = calculateWilsonInterval(0.5, 30, 0.5);
      const n100 = calculateWilsonInterval(0.5, 100, 0.5);
      const n1000 = calculateWilsonInterval(0.5, 1000, 0.5);

      const width30 = n30.upper - n30.lower;
      const width100 = n100.upper - n100.lower;
      const width1000 = n1000.upper - n1000.lower;

      expect(width30).toBeGreaterThan(width100);
      expect(width100).toBeGreaterThan(width1000);
    });

    it('should handle p = 0 (no overturns)', () => {
      const result = calculateWilsonInterval(0.1, 50, 0.0);
      expect(result.lower).toBe(0.0);
      expect(result.upper).toBeGreaterThan(0.0);
      expect(result.upper).toBeLessThanOrEqual(1.0);
    });

    it('should handle p = 1 (all overturns)', () => {
      const result = calculateWilsonInterval(0.9, 50, 1.0);
      expect(result.lower).toBeGreaterThanOrEqual(0.0);
      expect(result.lower).toBeLessThan(1.0);
      // Upper bound should be at or very close to 1.0
      expect(result.upper).toBeCloseTo(1.0, 10);
      expect(result.upper).toBeLessThanOrEqual(1.0);
    });

    it('should produce symmetric-ish interval around p = 0.5 with large n', () => {
      const result = calculateWilsonInterval(0.5, 1000, 0.5);
      const center = (result.lower + result.upper) / 2;
      // With large n, Wilson interval center should be close to p
      expect(center).toBeCloseTo(0.5, 2);
    });
  });

  describe('boundary at n = 30', () => {
    it('should NOT apply widening at exactly n = 30', () => {
      const n = 30;
      const p = 0.5;
      const z = Z_SCORE_90;
      const zSquared = z * z;

      const denominator = 1 + zSquared / n;
      const center = (p + zSquared / (2 * n)) / denominator;
      const margin = (z * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / denominator;

      const result = calculateWilsonInterval(0.5, n, p);

      // No widening factor applied at n = 30
      expect(result.lower).toBeCloseTo(center - margin, 10);
      expect(result.upper).toBeCloseTo(center + margin, 10);
    });

    it('should apply widening at n = 29', () => {
      const n = 29;
      const p = 0.5;
      const z = Z_SCORE_90;
      const zSquared = z * z;

      const denominator = 1 + zSquared / n;
      const center = (p + zSquared / (2 * n)) / denominator;
      const baseMargin = (z * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / denominator;
      const widenedMargin = baseMargin * (30 / n);

      const result = calculateWilsonInterval(0.5, n, p);

      const expectedLower = Math.max(0.0, center - widenedMargin);
      const expectedUpper = Math.min(1.0, center + widenedMargin);

      expect(result.lower).toBeCloseTo(expectedLower, 10);
      expect(result.upper).toBeCloseTo(expectedUpper, 10);
    });
  });

  describe('constants', () => {
    it('should use z = 1.645 for 90% confidence', () => {
      expect(Z_SCORE_90).toBe(1.645);
    });

    it('should use 30 as minimum sample size', () => {
      expect(MIN_SAMPLE_SIZE).toBe(30);
    });

    it('should use 0.90 as confidence level', () => {
      expect(CONFIDENCE_LEVEL).toBe(0.90);
    });
  });
});

// ─── queryHistoricalOutcomes Tests ──────────────────────────────────────────

describe('queryHistoricalOutcomes', () => {
  it('should count total and overturn outcomes correctly', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Items: [
          { GSI2PK: 'PAYER1#CO-45', GSI2SK: 'overturn' },
          { GSI2PK: 'PAYER1#CO-45', GSI2SK: 'partial_overturn' },
          { GSI2PK: 'PAYER1#CO-45', GSI2SK: 'upheld' },
          { GSI2PK: 'PAYER1#CO-45', GSI2SK: 'upheld' },
          { GSI2PK: 'PAYER1#CO-45', GSI2SK: 'overturn' },
        ],
      }),
    };

    const result = await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    expect(result.total_outcomes).toBe(5);
    expect(result.overturn_outcomes).toBe(3); // 2 overturn + 1 partial_overturn
    expect(result.overturn_rate).toBeCloseTo(0.6, 10);
  });

  it('should return zero outcomes when no items found', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Items: [],
      }),
    };

    const result = await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    expect(result.total_outcomes).toBe(0);
    expect(result.overturn_outcomes).toBe(0);
    expect(result.overturn_rate).toBe(0);
  });

  it('should return zero outcomes when Items is undefined', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({}),
    };

    const result = await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    expect(result.total_outcomes).toBe(0);
    expect(result.overturn_outcomes).toBe(0);
    expect(result.overturn_rate).toBe(0);
  });

  it('should handle DynamoDB errors gracefully', async () => {
    const mockClient = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB timeout')),
    };

    const result = await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    expect(result.total_outcomes).toBe(0);
    expect(result.overturn_outcomes).toBe(0);
    expect(result.overturn_rate).toBe(0);
  });

  it('should construct correct GSI2PK from payerId and denialReasonCode', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };

    await queryHistoricalOutcomes(mockClient, 'PAYER_ABC', 'CO-45');

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const command = mockClient.send.mock.calls[0][0];
    expect(command.input.KeyConditionExpression).toBe('GSI2PK = :pk');
    expect(command.input.ExpressionAttributeValues[':pk']).toBe('PAYER_ABC#CO-45');
    expect(command.input.IndexName).toBe('GSI2-PayerReason-Index');
  });

  it('should use provided table name', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };

    await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45', 'CustomTable');

    const command = mockClient.send.mock.calls[0][0];
    expect(command.input.TableName).toBe('CustomTable');
  });

  it('should default to DenialAppeals table name', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };

    await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    const command = mockClient.send.mock.calls[0][0];
    expect(command.input.TableName).toBe('DenialAppeals');
  });

  it('should count only overturn and partial_overturn as overturn outcomes', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Items: [
          { GSI2SK: 'overturn' },
          { GSI2SK: 'partial_overturn' },
          { GSI2SK: 'upheld' },
          { GSI2SK: 'upheld' },
          { GSI2SK: 'upheld' },
        ],
      }),
    };

    const result = await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    expect(result.overturn_outcomes).toBe(2);
    expect(result.total_outcomes).toBe(5);
    expect(result.overturn_rate).toBeCloseTo(0.4, 10);
  });

  it('should handle all outcomes being overturns', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Items: [
          { GSI2SK: 'overturn' },
          { GSI2SK: 'overturn' },
          { GSI2SK: 'partial_overturn' },
        ],
      }),
    };

    const result = await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    expect(result.overturn_outcomes).toBe(3);
    expect(result.total_outcomes).toBe(3);
    expect(result.overturn_rate).toBe(1.0);
  });

  it('should handle all outcomes being upheld', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Items: [
          { GSI2SK: 'upheld' },
          { GSI2SK: 'upheld' },
        ],
      }),
    };

    const result = await queryHistoricalOutcomes(mockClient, 'PAYER1', 'CO-45');

    expect(result.overturn_outcomes).toBe(0);
    expect(result.total_outcomes).toBe(2);
    expect(result.overturn_rate).toBe(0);
  });
});

// ─── buildConfidenceResult Tests ────────────────────────────────────────────

describe('buildConfidenceResult', () => {
  it('should set limited_historical_data = true when n < 30', () => {
    const result = buildConfidenceResult(0.5, 10, 0.5);
    expect(result.limited_historical_data).toBe(true);
  });

  it('should set limited_historical_data = true when n = 0', () => {
    const result = buildConfidenceResult(0.5, 0, 0);
    expect(result.limited_historical_data).toBe(true);
  });

  it('should set limited_historical_data = false when n >= 30', () => {
    const result = buildConfidenceResult(0.5, 30, 0.5);
    expect(result.limited_historical_data).toBe(false);
  });

  it('should set limited_historical_data = false when n = 100', () => {
    const result = buildConfidenceResult(0.5, 100, 0.5);
    expect(result.limited_historical_data).toBe(false);
  });

  it('should include confidence_interval with correct structure', () => {
    const result = buildConfidenceResult(0.7, 50, 0.6);
    expect(result.confidence_interval).toHaveProperty('lower');
    expect(result.confidence_interval).toHaveProperty('upper');
    expect(result.confidence_interval).toHaveProperty('confidence_level');
    expect(result.confidence_interval.confidence_level).toBe(0.90);
  });

  it('should return maximally wide interval when n = 0', () => {
    const result = buildConfidenceResult(0.5, 0, 0);
    expect(result.confidence_interval.lower).toBe(0.0);
    expect(result.confidence_interval.upper).toBe(1.0);
    expect(result.limited_historical_data).toBe(true);
  });

  it('should produce widened interval for sparse data', () => {
    const sparse = buildConfidenceResult(0.5, 10, 0.5);
    const adequate = buildConfidenceResult(0.5, 50, 0.5);

    const sparseWidth = sparse.confidence_interval.upper - sparse.confidence_interval.lower;
    const adequateWidth = adequate.confidence_interval.upper - adequate.confidence_interval.lower;

    expect(sparseWidth).toBeGreaterThan(adequateWidth);
    expect(sparse.limited_historical_data).toBe(true);
    expect(adequate.limited_historical_data).toBe(false);
  });

  it('should boundary: n = 29 is limited, n = 30 is not', () => {
    const n29 = buildConfidenceResult(0.5, 29, 0.5);
    const n30 = buildConfidenceResult(0.5, 30, 0.5);

    expect(n29.limited_historical_data).toBe(true);
    expect(n30.limited_historical_data).toBe(false);
  });
});
