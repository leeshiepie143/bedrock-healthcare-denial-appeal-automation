/**
 * Unit tests for Monthly Report Generation Lambda
 *
 * Tests performance summary calculation, volume change detection,
 * payer overturn rate change detection, and report storage/notification.
 *
 * Requirements: 8.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculatePerformanceSummary,
  calculateVolumeChanges,
  calculatePayerChanges,
  getMonthBounds,
  VOLUME_CHANGE_THRESHOLD,
  PAYER_RATE_CHANGE_THRESHOLD,
  setClients,
  resetClients,
  handler,
  type PerformanceSummary,
  type VolumeChange,
  type PayerChange,
} from '@lambdas/outcomes/monthly-report';

// ─── Helper to create outcome records ───────────────────────────────────────

function makeOutcome(overrides: Record<string, unknown> = {}) {
  return {
    PK: 'TENANT#t1',
    SK: 'OUTCOME#claim-1',
    outcome_type: 'overturn',
    denial_reason_code: 'CO-45',
    payer_id: 'PAYER1',
    recovered_amount: 1500.00,
    time_to_resolution_days: 14,
    received_at: '2024-03-15T00:00:00.000Z',
    ...overrides,
  };
}

// ─── calculatePerformanceSummary Tests ──────────────────────────────────────

describe('calculatePerformanceSummary', () => {
  it('should return zeros for empty outcomes', () => {
    const result = calculatePerformanceSummary([]);
    expect(result.total_appeals).toBe(0);
    expect(result.overturn_count).toBe(0);
    expect(result.overturn_rate).toBe(0);
    expect(result.total_recovered_revenue).toBe(0);
    expect(result.average_resolution_time_days).toBe(0);
  });

  it('should calculate correct totals for a set of outcomes', () => {
    const outcomes = [
      makeOutcome({ outcome_type: 'overturn', recovered_amount: 1000, time_to_resolution_days: 10 }),
      makeOutcome({ outcome_type: 'partial_overturn', recovered_amount: 500, time_to_resolution_days: 15 }),
      makeOutcome({ outcome_type: 'upheld', recovered_amount: 0, time_to_resolution_days: 20 }),
      makeOutcome({ outcome_type: 'overturn', recovered_amount: 2000, time_to_resolution_days: 5 }),
    ];

    const result = calculatePerformanceSummary(outcomes as any);

    expect(result.total_appeals).toBe(4);
    expect(result.overturn_count).toBe(3); // 2 overturn + 1 partial_overturn
    expect(result.overturn_rate).toBe(0.75);
    expect(result.total_recovered_revenue).toBe(3500);
    expect(result.average_resolution_time_days).toBe(12.5);
  });

  it('should count partial_overturn as overturn', () => {
    const outcomes = [
      makeOutcome({ outcome_type: 'partial_overturn' }),
      makeOutcome({ outcome_type: 'partial_overturn' }),
      makeOutcome({ outcome_type: 'upheld' }),
    ];

    const result = calculatePerformanceSummary(outcomes as any);
    expect(result.overturn_count).toBe(2);
    expect(result.overturn_rate).toBeCloseTo(2 / 3, 10);
  });

  it('should handle all upheld outcomes', () => {
    const outcomes = [
      makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
      makeOutcome({ outcome_type: 'upheld', recovered_amount: 0 }),
    ];

    const result = calculatePerformanceSummary(outcomes as any);
    expect(result.overturn_count).toBe(0);
    expect(result.overturn_rate).toBe(0);
    expect(result.total_recovered_revenue).toBe(0);
  });

  it('should handle all overturn outcomes', () => {
    const outcomes = [
      makeOutcome({ outcome_type: 'overturn', recovered_amount: 1000 }),
      makeOutcome({ outcome_type: 'overturn', recovered_amount: 2000 }),
    ];

    const result = calculatePerformanceSummary(outcomes as any);
    expect(result.overturn_count).toBe(2);
    expect(result.overturn_rate).toBe(1.0);
    expect(result.total_recovered_revenue).toBe(3000);
  });

  it('should round recovered revenue to 2 decimal places', () => {
    const outcomes = [
      makeOutcome({ recovered_amount: 100.333 }),
      makeOutcome({ recovered_amount: 200.667 }),
    ];

    const result = calculatePerformanceSummary(outcomes as any);
    expect(result.total_recovered_revenue).toBe(301.0);
  });
});

// ─── calculateVolumeChanges Tests ───────────────────────────────────────────

describe('calculateVolumeChanges', () => {
  it('should return empty array when no volume changes exceed threshold', () => {
    const current = [
      makeOutcome({ denial_reason_code: 'CO-45' }),
      makeOutcome({ denial_reason_code: 'CO-45' }),
    ];
    const prior = [
      makeOutcome({ denial_reason_code: 'CO-45' }),
      makeOutcome({ denial_reason_code: 'CO-45' }),
    ];

    const result = calculateVolumeChanges(current as any, prior as any);
    expect(result).toHaveLength(0);
  });

  it('should detect volume increase >= 20%', () => {
    // Prior: 10 outcomes, Current: 13 outcomes (30% increase)
    const prior = Array.from({ length: 10 }, () => makeOutcome({ denial_reason_code: 'CO-45' }));
    const current = Array.from({ length: 13 }, () => makeOutcome({ denial_reason_code: 'CO-45' }));

    const result = calculateVolumeChanges(current as any, prior as any);

    expect(result).toHaveLength(1);
    expect(result[0].denial_reason_code).toBe('CO-45');
    expect(result[0].current_month_volume).toBe(13);
    expect(result[0].prior_month_volume).toBe(10);
    expect(result[0].change_percentage).toBeCloseTo(0.3, 10);
  });

  it('should not flag volume increase below 20%', () => {
    // Prior: 10 outcomes, Current: 11 outcomes (10% increase)
    const prior = Array.from({ length: 10 }, () => makeOutcome({ denial_reason_code: 'CO-45' }));
    const current = Array.from({ length: 11 }, () => makeOutcome({ denial_reason_code: 'CO-45' }));

    const result = calculateVolumeChanges(current as any, prior as any);
    expect(result).toHaveLength(0);
  });

  it('should flag exactly 20% increase', () => {
    // Prior: 10 outcomes, Current: 12 outcomes (20% increase)
    const prior = Array.from({ length: 10 }, () => makeOutcome({ denial_reason_code: 'CO-45' }));
    const current = Array.from({ length: 12 }, () => makeOutcome({ denial_reason_code: 'CO-45' }));

    const result = calculateVolumeChanges(current as any, prior as any);
    expect(result).toHaveLength(1);
    expect(result[0].change_percentage).toBeCloseTo(0.2, 10);
  });

  it('should not flag new denial reasons (prior month had zero)', () => {
    const current = Array.from({ length: 20 }, () => makeOutcome({ denial_reason_code: 'NEW-CODE' }));
    const prior: any[] = [];

    const result = calculateVolumeChanges(current as any, prior);
    expect(result).toHaveLength(0);
  });

  it('should sort results by change percentage descending', () => {
    const prior = [
      ...Array.from({ length: 10 }, () => makeOutcome({ denial_reason_code: 'CO-45' })),
      ...Array.from({ length: 10 }, () => makeOutcome({ denial_reason_code: 'CO-16' })),
    ];
    const current = [
      ...Array.from({ length: 15 }, () => makeOutcome({ denial_reason_code: 'CO-45' })), // 50% increase
      ...Array.from({ length: 13 }, () => makeOutcome({ denial_reason_code: 'CO-16' })), // 30% increase
    ];

    const result = calculateVolumeChanges(current as any, prior as any);

    expect(result).toHaveLength(2);
    expect(result[0].denial_reason_code).toBe('CO-45'); // 50% > 30%
    expect(result[1].denial_reason_code).toBe('CO-16');
  });

  it('should use 0.20 as the volume change threshold', () => {
    expect(VOLUME_CHANGE_THRESHOLD).toBe(0.20);
  });
});

// ─── calculatePayerChanges Tests ────────────────────────────────────────────

describe('calculatePayerChanges', () => {
  it('should return empty array when no payer rate changes exceed 10pp', () => {
    // Both months: 50% overturn rate
    const current = [
      makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' }),
      makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' }),
    ];
    const prior = [
      makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' }),
      makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' }),
    ];

    const result = calculatePayerChanges(current as any, prior as any);
    expect(result).toHaveLength(0);
  });

  it('should detect payer rate increase >= 10 percentage points', () => {
    // Prior: 40% overturn (4/10), Current: 60% overturn (6/10) = +20pp
    const prior = [
      ...Array.from({ length: 4 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 6 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
    ];
    const current = [
      ...Array.from({ length: 6 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 4 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
    ];

    const result = calculatePayerChanges(current as any, prior as any);

    expect(result).toHaveLength(1);
    expect(result[0].payer_id).toBe('P1');
    expect(result[0].current_month_rate).toBeCloseTo(0.6, 10);
    expect(result[0].prior_month_rate).toBeCloseTo(0.4, 10);
    expect(result[0].change_percentage_points).toBeCloseTo(0.2, 10);
  });

  it('should detect payer rate decrease >= 10 percentage points', () => {
    // Prior: 70% overturn (7/10), Current: 50% overturn (5/10) = -20pp
    const prior = [
      ...Array.from({ length: 7 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 3 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
    ];
    const current = [
      ...Array.from({ length: 5 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 5 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
    ];

    const result = calculatePayerChanges(current as any, prior as any);

    expect(result).toHaveLength(1);
    expect(result[0].change_percentage_points).toBeCloseTo(-0.2, 10);
  });

  it('should not flag change below 10 percentage points', () => {
    // Prior: 50% (5/10), Current: 55% (11/20) = +5pp
    const prior = [
      ...Array.from({ length: 5 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 5 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
    ];
    const current = [
      ...Array.from({ length: 11 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 9 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
    ];

    const result = calculatePayerChanges(current as any, prior as any);
    expect(result).toHaveLength(0);
  });

  it('should not flag payers only present in current month', () => {
    const current = [
      makeOutcome({ payer_id: 'NEW_PAYER', outcome_type: 'overturn' }),
    ];
    const prior: any[] = [];

    const result = calculatePayerChanges(current as any, prior);
    expect(result).toHaveLength(0);
  });

  it('should sort by absolute change descending', () => {
    // P1: +30pp change, P2: -20pp change
    const prior = [
      ...Array.from({ length: 3 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 7 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
      ...Array.from({ length: 7 }, () => makeOutcome({ payer_id: 'P2', outcome_type: 'overturn' })),
      ...Array.from({ length: 3 }, () => makeOutcome({ payer_id: 'P2', outcome_type: 'upheld' })),
    ];
    const current = [
      ...Array.from({ length: 6 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'overturn' })),
      ...Array.from({ length: 4 }, () => makeOutcome({ payer_id: 'P1', outcome_type: 'upheld' })),
      ...Array.from({ length: 5 }, () => makeOutcome({ payer_id: 'P2', outcome_type: 'overturn' })),
      ...Array.from({ length: 5 }, () => makeOutcome({ payer_id: 'P2', outcome_type: 'upheld' })),
    ];

    const result = calculatePayerChanges(current as any, prior as any);

    expect(result).toHaveLength(2);
    // P1 has +30pp, P2 has -20pp, so P1 first by absolute value
    expect(result[0].payer_id).toBe('P1');
    expect(result[1].payer_id).toBe('P2');
  });

  it('should use 0.10 as the payer rate change threshold', () => {
    expect(PAYER_RATE_CHANGE_THRESHOLD).toBe(0.10);
  });
});

// ─── getMonthBounds Tests ───────────────────────────────────────────────────

describe('getMonthBounds', () => {
  it('should return correct bounds for January', () => {
    const bounds = getMonthBounds(2024, 0); // January
    expect(bounds.start).toBe('2024-01-01T00:00:00.000Z');
    expect(bounds.end).toBe('2024-02-01T00:00:00.000Z');
  });

  it('should return correct bounds for December', () => {
    const bounds = getMonthBounds(2024, 11); // December
    expect(bounds.start).toBe('2024-12-01T00:00:00.000Z');
    expect(bounds.end).toBe('2025-01-01T00:00:00.000Z');
  });

  it('should return correct bounds for February in a leap year', () => {
    const bounds = getMonthBounds(2024, 1); // February 2024 (leap year)
    expect(bounds.start).toBe('2024-02-01T00:00:00.000Z');
    expect(bounds.end).toBe('2024-03-01T00:00:00.000Z');
  });

  it('should return correct bounds for a mid-year month', () => {
    const bounds = getMonthBounds(2024, 6); // July
    expect(bounds.start).toBe('2024-07-01T00:00:00.000Z');
    expect(bounds.end).toBe('2024-08-01T00:00:00.000Z');
  });
});

// ─── Handler Integration Tests ──────────────────────────────────────────────

describe('handler', () => {
  beforeEach(() => {
    resetClients();
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
  });

  it('should generate report with zero outcomes', async () => {
    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };
    const mockSns = { send: vi.fn().mockResolvedValue({}) };

    setClients({ dynamo: mockDynamo as any, sns: mockSns as any });

    const result = await handler();

    expect(result.stored).toBe(true);
    expect(result.performance_summary.total_appeals).toBe(0);
    expect(result.volume_changes_count).toBe(0);
    expect(result.payer_changes_count).toBe(0);
  });

  it('should store report in DynamoDB with correct PK/SK', async () => {
    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };
    const mockSns = { send: vi.fn().mockResolvedValue({}) };

    setClients({ dynamo: mockDynamo as any, sns: mockSns as any });

    await handler();

    // The PutCommand should have been called with PK=REPORT and SK=MONTHLY#<YYYY-MM>
    const putCall = mockDynamo.send.mock.calls.find(
      (call: any) => call[0]?.input?.Item?.PK === 'REPORT'
    );
    expect(putCall).toBeDefined();
    expect(putCall![0].input.Item.SK).toMatch(/^MONTHLY#\d{4}-\d{2}$/);
  });

  it('should send SNS notification with report summary', async () => {
    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };
    const mockSns = { send: vi.fn().mockResolvedValue({}) };

    setClients({ dynamo: mockDynamo as any, sns: mockSns as any });

    const result = await handler();

    expect(result.notified).toBe(true);
    expect(mockSns.send).toHaveBeenCalled();
  });

  it('should handle SNS_TOPIC_ARN not configured', async () => {
    delete process.env.SNS_TOPIC_ARN;

    const mockDynamo = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    };

    setClients({ dynamo: mockDynamo as any });

    const result = await handler();

    expect(result.notified).toBe(false);
  });
});
