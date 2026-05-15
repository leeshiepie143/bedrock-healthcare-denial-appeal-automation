import { describe, it, expect } from 'vitest';
import {
  isValidISO8601,
  isValidISO8601WithMillisUTC,
  isValidUSDAmount,
  roundToUSD,
  isValidScore,
  createEnumValidator,
  isNonEmptyString,
  isPositiveInteger,
  validateDenialRecordFields,
  validateOutcomeFields,
  isValidSourceFormat,
  isValidDenialStatus,
  isValidOutcomeType,
  isValidWorkflowStatusType,
} from '../../../src/shared/validation';

describe('ISO 8601 Validation', () => {
  describe('isValidISO8601', () => {
    it('accepts date-only format YYYY-MM-DD', () => {
      expect(isValidISO8601('2024-01-15')).toBe(true);
      expect(isValidISO8601('2023-12-31')).toBe(true);
    });

    it('accepts datetime with Z timezone', () => {
      expect(isValidISO8601('2024-01-15T10:30:00Z')).toBe(true);
    });

    it('accepts datetime with milliseconds and Z', () => {
      expect(isValidISO8601('2024-01-15T10:30:00.123Z')).toBe(true);
    });

    it('accepts datetime with offset timezone', () => {
      expect(isValidISO8601('2024-01-15T10:30:00+05:30')).toBe(true);
      expect(isValidISO8601('2024-01-15T10:30:00-08:00')).toBe(true);
    });

    it('rejects invalid dates', () => {
      expect(isValidISO8601('2024-02-30')).toBe(false); // Feb 30 doesn't exist
      expect(isValidISO8601('not-a-date')).toBe(false);
      expect(isValidISO8601('')).toBe(false);
      expect(isValidISO8601('2024-13-01')).toBe(false); // month 13
      expect(isValidISO8601('2024-00-01')).toBe(false); // month 0
    });

    it('rejects datetime without timezone', () => {
      expect(isValidISO8601('2024-01-15T10:30:00')).toBe(false);
    });
  });

  describe('isValidISO8601WithMillisUTC', () => {
    it('accepts valid millisecond UTC timestamps', () => {
      expect(isValidISO8601WithMillisUTC('2024-01-15T10:30:00.123Z')).toBe(true);
      expect(isValidISO8601WithMillisUTC('2024-12-31T23:59:59.999Z')).toBe(true);
    });

    it('rejects timestamps without milliseconds', () => {
      expect(isValidISO8601WithMillisUTC('2024-01-15T10:30:00Z')).toBe(false);
    });

    it('rejects timestamps with non-UTC timezone', () => {
      expect(isValidISO8601WithMillisUTC('2024-01-15T10:30:00.123+05:00')).toBe(false);
    });

    it('rejects date-only format', () => {
      expect(isValidISO8601WithMillisUTC('2024-01-15')).toBe(false);
    });
  });
});

describe('USD Amount Validation', () => {
  describe('isValidUSDAmount', () => {
    it('accepts valid amounts', () => {
      expect(isValidUSDAmount(0)).toBe(true);
      expect(isValidUSDAmount(100)).toBe(true);
      expect(isValidUSDAmount(99.99)).toBe(true);
      expect(isValidUSDAmount(1234.50)).toBe(true);
    });

    it('rejects negative amounts', () => {
      expect(isValidUSDAmount(-1)).toBe(false);
      expect(isValidUSDAmount(-0.01)).toBe(false);
    });

    it('rejects amounts with more than 2 decimal places', () => {
      expect(isValidUSDAmount(10.123)).toBe(false);
      expect(isValidUSDAmount(0.001)).toBe(false);
    });

    it('rejects NaN and Infinity', () => {
      expect(isValidUSDAmount(NaN)).toBe(false);
      expect(isValidUSDAmount(Infinity)).toBe(false);
      expect(isValidUSDAmount(-Infinity)).toBe(false);
    });
  });

  describe('roundToUSD', () => {
    it('rounds to 2 decimal places', () => {
      expect(roundToUSD(10.126)).toBe(10.13);
      expect(roundToUSD(10.124)).toBe(10.12);
      expect(roundToUSD(10.1)).toBe(10.1);
      expect(roundToUSD(10)).toBe(10);
    });
  });
});

describe('Score Validation', () => {
  describe('isValidScore', () => {
    it('accepts values in [0.0, 1.0]', () => {
      expect(isValidScore(0)).toBe(true);
      expect(isValidScore(0.5)).toBe(true);
      expect(isValidScore(1.0)).toBe(true);
    });

    it('rejects values outside [0.0, 1.0]', () => {
      expect(isValidScore(-0.1)).toBe(false);
      expect(isValidScore(1.1)).toBe(false);
    });

    it('rejects NaN and Infinity', () => {
      expect(isValidScore(NaN)).toBe(false);
      expect(isValidScore(Infinity)).toBe(false);
    });
  });
});

describe('Enum Validation', () => {
  describe('createEnumValidator', () => {
    const isValidColor = createEnumValidator(['red', 'green', 'blue'] as const);

    it('accepts valid enum values', () => {
      expect(isValidColor('red')).toBe(true);
      expect(isValidColor('green')).toBe(true);
      expect(isValidColor('blue')).toBe(true);
    });

    it('rejects invalid enum values', () => {
      expect(isValidColor('yellow')).toBe(false);
      expect(isValidColor('')).toBe(false);
      expect(isValidColor('RED')).toBe(false); // case-sensitive
    });
  });

  describe('pre-built validators', () => {
    it('validates source formats', () => {
      expect(isValidSourceFormat('pdf')).toBe(true);
      expect(isValidSourceFormat('edi_835')).toBe(true);
      expect(isValidSourceFormat('docx')).toBe(false);
    });

    it('validates denial statuses', () => {
      expect(isValidDenialStatus('ingested')).toBe(true);
      expect(isValidDenialStatus('resolved')).toBe(true);
      expect(isValidDenialStatus('unknown')).toBe(false);
    });

    it('validates outcome types', () => {
      expect(isValidOutcomeType('overturn')).toBe(true);
      expect(isValidOutcomeType('partial_overturn')).toBe(true);
      expect(isValidOutcomeType('denied')).toBe(false);
    });

    it('validates workflow status types', () => {
      expect(isValidWorkflowStatusType('queued')).toBe(true);
      expect(isValidWorkflowStatusType('awaiting_retry')).toBe(true);
      expect(isValidWorkflowStatusType('running')).toBe(false);
    });
  });
});

describe('String and Number Helpers', () => {
  describe('isNonEmptyString', () => {
    it('accepts non-empty strings', () => {
      expect(isNonEmptyString('hello')).toBe(true);
      expect(isNonEmptyString('a')).toBe(true);
    });

    it('rejects empty or whitespace-only strings', () => {
      expect(isNonEmptyString('')).toBe(false);
      expect(isNonEmptyString('   ')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(undefined)).toBe(false);
      expect(isNonEmptyString(123)).toBe(false);
    });
  });

  describe('isPositiveInteger', () => {
    it('accepts positive integers', () => {
      expect(isPositiveInteger(1)).toBe(true);
      expect(isPositiveInteger(100)).toBe(true);
    });

    it('rejects zero and negative numbers', () => {
      expect(isPositiveInteger(0)).toBe(false);
      expect(isPositiveInteger(-1)).toBe(false);
    });

    it('rejects non-integers', () => {
      expect(isPositiveInteger(1.5)).toBe(false);
    });
  });
});

describe('Composite Validators', () => {
  describe('validateDenialRecordFields', () => {
    it('passes with all valid fields', () => {
      const result = validateDenialRecordFields({
        claim_id: 'CLM-001',
        patient_id: 'PAT-001',
        payer_id: 'PAY-001',
        denial_date: '2024-01-15',
        denied_amount: 1500.00,
        raw_denial_reason_text: 'Service not covered',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports all missing fields', () => {
      const result = validateDenialRecordFields({});
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(6);
    });

    it('reports specific invalid fields', () => {
      const result = validateDenialRecordFields({
        claim_id: 'CLM-001',
        patient_id: '',
        payer_id: 'PAY-001',
        denial_date: 'not-a-date',
        denied_amount: -100,
        raw_denial_reason_text: 'Some reason',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('patient_id must be a non-empty string');
      expect(result.errors).toContain('denial_date must be a valid ISO 8601 date string');
      expect(result.errors).toContain('denied_amount must be a non-negative number with at most 2 decimal places');
    });
  });

  describe('validateOutcomeFields', () => {
    it('passes with all valid fields', () => {
      const result = validateOutcomeFields({
        denial_reason_code: 'CO-4',
        payer_id: 'PAY-001',
        outcome_type: 'overturn',
        time_to_resolution_days: 30,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports missing required fields', () => {
      const result = validateOutcomeFields({});
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(4);
    });

    it('rejects invalid outcome_type', () => {
      const result = validateOutcomeFields({
        denial_reason_code: 'CO-4',
        payer_id: 'PAY-001',
        outcome_type: 'invalid',
        time_to_resolution_days: 30,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('outcome_type must be one of: overturn, partial_overturn, upheld');
    });
  });
});
