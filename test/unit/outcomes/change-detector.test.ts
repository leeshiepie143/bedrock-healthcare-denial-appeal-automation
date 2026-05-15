/**
 * Unit tests for Statistical Change Detection Lambda
 *
 * Tests chi-squared calculation, outcome grouping, alert generation,
 * and boundary conditions for the change detection logic.
 *
 * Requirements: 8.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateChiSquared,
  groupOutcomes,
  CHI_SQUARED_CRITICAL_VALUE,
  MINIMUM_OUTCOMES,
  BASELINE_DAYS,
  setClients,
  resetClients,
  handler,
  type ChangeAlert,
  type ChiSquaredResult,
} from '@lambdas/outcomes/change-detector';

// ─── calculateChiSquared Tests ──────────────────────────────────────────────

describe('calculateChiSquared', () => {
  describe('basic properties', () => {
    it('should return chiSquared >= 0', () => {
      const result = calculateChiSquared(20, 10, 15, 15);
      expect(result.chiSquared).toBeGreaterThanOrEqual(0);
    });

    it('should return pValue between 0 and 1', () => {
      const result = calculateChiSquared(20, 10, 15, 15);
      expect(result.pValue).toBeGreaterThanOrEqual(0);
      expect(result.pValue).toBeLessThanOrEqual(1);
    });

    it('should flag significant when chiSquared >= 3.841', () => {
      // Large difference should be significant
      const result = calculateChiSquared(25, 5, 10, 20);
      expect(result.chiSquared).toBeGreaterThan(CHI_SQUARED_CRITICAL_VALUE);
      expect(result.significant).toBe(true);
    });

    it('should not flag significant when chiSquared < 3.841', () => {
      // Similar rates should not be significant
      const result = calculateChiSquared(15, 15, 14, 16);
      expect(result.chiSquared).toBeLessThan(CHI_SQUARED_CRITICAL_VALUE);
      expect(result.significant).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return zero chi-squared when all inputs are zero', () => {
      const result = calculateChiSquared(0, 0, 0, 0);
      expect(result.chiSquared).toBe(0);
      expect(result.pValue).toBe(1.0);
      expect(result.significant).toBe(false);
    });

    it('should return zero chi-squared when current period is all zeros', () => {
      const result = calculateChiSquared(0, 0, 10, 20);
      expect(result.chiSquared).toBe(0);
      expect(result.pValue).toBe(1.0);
      expect(result.significant).toBe(false);
    });

    it('should return zero chi-squared when baseline is all zeros', () => {
      const result = calculateChiSquared(10, 20, 0, 0);
      expect(result.chiSquared).toBe(0);
      expect(result.pValue).toBe(1.0);
      expect(result.significant).toBe(false);
    });

    it('should handle case where all outcomes are overturns', () => {
      // All overturns in both periods (no upheld)
      const result = calculateChiSquared(30, 0, 20, 0);
      expect(result.chiSquared).toBe(0);
      expect(result.significant).toBe(false);
    });

    it('should handle case where all outcomes are upheld', () => {
      // All upheld in both periods (no overturns)
      const result = calculateChiSquared(0, 30, 0, 20);
      expect(result.chiSquared).toBe(0);
      expect(result.significant).toBe(false);
    });

    it('should handle identical rates (no change)', () => {
      // Same rate in both periods: 50% overturn
      const result = calculateChiSquared(15, 15, 15, 15);
      expect(result.chiSquared).toBe(0);
      expect(result.significant).toBe(false);
    });
  });

  describe('known values', () => {
    it('should calculate correctly for a known significant case', () => {
      // Current: 80% overturn (24/30), Baseline: 40% overturn (12/30)
      // This should be highly significant
      const a = 24, b = 6, c = 12, d = 18;
      const n = a + b + c + d; // 60
      const expectedNumerator = n * Math.pow(a * d - b * c, 2);
      const expectedDenominator = (a + b) * (c + d) * (a + c) * (b + d);
      const expectedChiSquared = expectedNumerator / expectedDenominator;

      const result = calculateChiSquared(a, b, c, d);
      expect(result.chiSquared).toBeCloseTo(expectedChiSquared, 6);
      expect(result.significant).toBe(true);
    });

    it('should calculate correctly for a known non-significant case', () => {
      // Current: 52% overturn (26/50), Baseline: 48% overturn (24/50)
      // Small difference, should not be significant
      const a = 26, b = 24, c = 24, d = 26;
      const n = a + b + c + d; // 100
      const expectedNumerator = n * Math.pow(a * d - b * c, 2);
      const expectedDenominator = (a + b) * (c + d) * (a + c) * (b + d);
      const expectedChiSquared = expectedNumerator / expectedDenominator;

      const result = calculateChiSquared(a, b, c, d);
      expect(result.chiSquared).toBeCloseTo(expectedChiSquared, 6);
      expect(result.significant).toBe(false);
    });

    it('should detect significance at the boundary (chi-squared ≈ 3.841)', () => {
      // Construct a case near the boundary
      // With n=100, we need ad-bc such that χ² ≈ 3.841
      // χ² = 100 * (ad-bc)² / ((a+b)(c+d)(a+c)(b+d))
      // For a=30, b=20, c=20, d=30: χ² = 100*(900-400)²/(50*50*50*50) = 100*250000/6250000 = 4.0
      const result = calculateChiSquared(30, 20, 20, 30);
      expect(result.chiSquared).toBeCloseTo(4.0, 1);
      expect(result.significant).toBe(true);
    });
  });

  describe('constants', () => {
    it('should use 3.841 as the critical value for p=0.05 with 1 df', () => {
      expect(CHI_SQUARED_CRITICAL_VALUE).toBe(3.841);
    });

    it('should require minimum 30 outcomes', () => {
      expect(MINIMUM_OUTCOMES).toBe(30);
    });

    it('should use 90-day baseline', () => {
      expect(BASELINE_DAYS).toBe(90);
    });
  });
});

// ─── groupOutcomes Tests ────────────────────────────────────────────────────

describe('groupOutcomes', () => {
  const currentPeriodStart = '2024-03-01T00:00:00.000Z';

  it('should group outcomes by payer_id and denial_reason_code', () => {
    const outcomes = [
      { PK: 'T#1', SK: 'O#1', outcome_type: 'overturn', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 100, time_to_resolution_days: 10, received_at: '2024-03-05T00:00:00.000Z' },
      { PK: 'T#1', SK: 'O#2', outcome_type: 'upheld', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 0, time_to_resolution_days: 15, received_at: '2024-03-10T00:00:00.000Z' },
      { PK: 'T#1', SK: 'O#3', outcome_type: 'overturn', payer_id: 'P2', denial_reason_code: 'CO-16', recovered_amount: 200, time_to_resolution_days: 5, received_at: '2024-03-15T00:00:00.000Z' },
    ];

    const result = groupOutcomes(outcomes, currentPeriodStart);

    expect(result.size).toBe(2);
    expect(result.has('P1#CO-45')).toBe(true);
    expect(result.has('P2#CO-16')).toBe(true);
  });

  it('should split outcomes into current and baseline periods', () => {
    const outcomes = [
      // Current period (after currentPeriodStart)
      { PK: 'T#1', SK: 'O#1', outcome_type: 'overturn', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 100, time_to_resolution_days: 10, received_at: '2024-03-05T00:00:00.000Z' },
      { PK: 'T#1', SK: 'O#2', outcome_type: 'upheld', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 0, time_to_resolution_days: 15, received_at: '2024-03-10T00:00:00.000Z' },
      // Baseline period (before currentPeriodStart)
      { PK: 'T#1', SK: 'O#3', outcome_type: 'overturn', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 50, time_to_resolution_days: 20, received_at: '2024-02-15T00:00:00.000Z' },
      { PK: 'T#1', SK: 'O#4', outcome_type: 'upheld', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 0, time_to_resolution_days: 25, received_at: '2024-01-20T00:00:00.000Z' },
      { PK: 'T#1', SK: 'O#5', outcome_type: 'upheld', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 0, time_to_resolution_days: 12, received_at: '2024-02-01T00:00:00.000Z' },
    ];

    const result = groupOutcomes(outcomes, currentPeriodStart);
    const data = result.get('P1#CO-45')!;

    expect(data.currentTotal).toBe(2);
    expect(data.currentOverturn).toBe(1);
    expect(data.baselineTotal).toBe(3);
    expect(data.baselineOverturn).toBe(1);
  });

  it('should count partial_overturn as overturn', () => {
    const outcomes = [
      { PK: 'T#1', SK: 'O#1', outcome_type: 'partial_overturn', payer_id: 'P1', denial_reason_code: 'CO-45', recovered_amount: 50, time_to_resolution_days: 10, received_at: '2024-03-05T00:00:00.000Z' },
    ];

    const result = groupOutcomes(outcomes, currentPeriodStart);
    const data = result.get('P1#CO-45')!;

    expect(data.currentOverturn).toBe(1);
  });

  it('should return empty map for empty outcomes', () => {
    const result = groupOutcomes([], currentPeriodStart);
    expect(result.size).toBe(0);
  });
});

// ─── Handler Integration Tests ──────────────────────────────────────────────

describe('handler', () => {
  beforeEach(() => {
    resetClients();
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
  });

  it('should return zero alerts when no outcomes exist', async () => {
    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };
    const mockSns = { send: vi.fn().mockResolvedValue({}) };

    setClients({ dynamo: mockDynamo as any, sns: mockSns as any });

    const result = await handler();

    expect(result.analyzed_combinations).toBe(0);
    expect(result.alerts_generated).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('should skip combinations with fewer than 30 current period outcomes', async () => {
    // Create outcomes where current period has < 30
    const outcomes = Array.from({ length: 20 }, (_, i) => ({
      PK: 'T#1',
      SK: `OUTCOME#claim-${i}`,
      outcome_type: i % 2 === 0 ? 'overturn' : 'upheld',
      payer_id: 'PAYER1',
      denial_reason_code: 'CO-45',
      recovered_amount: 100,
      time_to_resolution_days: 10,
      received_at: new Date().toISOString(), // All in current period
    }));

    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: outcomes }),
    };
    const mockSns = { send: vi.fn().mockResolvedValue({}) };

    setClients({ dynamo: mockDynamo as any, sns: mockSns as any });

    const result = await handler();

    expect(result.skipped_insufficient_data).toBeGreaterThan(0);
    expect(result.alerts_generated).toBe(0);
  });

  it('should generate alert when significant change is detected', async () => {
    const now = new Date();
    const currentDate = new Date(now);
    const baselineDate = new Date(now);
    baselineDate.setUTCDate(baselineDate.getUTCDate() - 60); // In baseline period

    // Current period: 80% overturn rate (24 overturn, 6 upheld)
    const currentOutcomes = Array.from({ length: 30 }, (_, i) => ({
      PK: 'T#1',
      SK: `OUTCOME#claim-current-${i}`,
      outcome_type: i < 24 ? 'overturn' : 'upheld',
      payer_id: 'PAYER1',
      denial_reason_code: 'CO-45',
      recovered_amount: 100,
      time_to_resolution_days: 10,
      received_at: currentDate.toISOString(),
    }));

    // Baseline period: 30% overturn rate (9 overturn, 21 upheld)
    const baselineOutcomes = Array.from({ length: 30 }, (_, i) => ({
      PK: 'T#1',
      SK: `OUTCOME#claim-baseline-${i}`,
      outcome_type: i < 9 ? 'overturn' : 'upheld',
      payer_id: 'PAYER1',
      denial_reason_code: 'CO-45',
      recovered_amount: 50,
      time_to_resolution_days: 20,
      received_at: baselineDate.toISOString(),
    }));

    const allOutcomes = [...currentOutcomes, ...baselineOutcomes];

    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: allOutcomes }),
    };
    const mockSns = { send: vi.fn().mockResolvedValue({}) };

    setClients({ dynamo: mockDynamo as any, sns: mockSns as any });

    const result = await handler();

    expect(result.alerts_generated).toBe(1);
    expect(result.alerts[0].payer_id).toBe('PAYER1');
    expect(result.alerts[0].denial_reason_code).toBe('CO-45');
    expect(result.alerts[0].direction).toBe('increase');
    expect(mockSns.send).toHaveBeenCalled();
  });

  it('should not generate alert when rates are similar', async () => {
    const now = new Date();
    const currentDate = new Date(now);
    const baselineDate = new Date(now);
    baselineDate.setUTCDate(baselineDate.getUTCDate() - 60);

    // Current period: 50% overturn rate (15/30)
    const currentOutcomes = Array.from({ length: 30 }, (_, i) => ({
      PK: 'T#1',
      SK: `OUTCOME#claim-current-${i}`,
      outcome_type: i < 15 ? 'overturn' : 'upheld',
      payer_id: 'PAYER1',
      denial_reason_code: 'CO-45',
      recovered_amount: 100,
      time_to_resolution_days: 10,
      received_at: currentDate.toISOString(),
    }));

    // Baseline period: 50% overturn rate (15/30)
    const baselineOutcomes = Array.from({ length: 30 }, (_, i) => ({
      PK: 'T#1',
      SK: `OUTCOME#claim-baseline-${i}`,
      outcome_type: i < 15 ? 'overturn' : 'upheld',
      payer_id: 'PAYER1',
      denial_reason_code: 'CO-45',
      recovered_amount: 50,
      time_to_resolution_days: 20,
      received_at: baselineDate.toISOString(),
    }));

    const allOutcomes = [...currentOutcomes, ...baselineOutcomes];

    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: allOutcomes }),
    };
    const mockSns = { send: vi.fn().mockResolvedValue({}) };

    setClients({ dynamo: mockDynamo as any, sns: mockSns as any });

    const result = await handler();

    expect(result.alerts_generated).toBe(0);
    expect(mockSns.send).not.toHaveBeenCalled();
  });
});
