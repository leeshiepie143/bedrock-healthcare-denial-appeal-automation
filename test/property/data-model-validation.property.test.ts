/**
 * Property 2: Denial_Record Schema Invariant
 *
 * Generate arbitrary valid inputs across all source formats; verify produced
 * Denial_Record always contains all mandatory fields with correct types.
 *
 * Validates: Requirements 1.6
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateDenialRecordFields, isValidISO8601, isValidUSDAmount } from '@shared/validation';
import type { SourceFormat } from '@shared/models';

// ─── Arbitraries ────────────────────────────────────────────────────────────

const sourceFormats: SourceFormat[] = ['pdf', 'tiff', 'png', 'jpeg', 'edi_835', 'edi_277'];

/** Generates a non-empty alphanumeric string (1-50 chars) for IDs */
const nonEmptyIdArb = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
  minLength: 1,
  maxLength: 50,
});

/** Generates a valid ISO 8601 date string (YYYY-MM-DD) */
const validISODateArb = fc.tuple(
  fc.integer({ min: 2000, max: 2030 }),
  fc.integer({ min: 1, max: 12 }),
  fc.integer({ min: 1, max: 28 }) // Use 28 to avoid invalid day-of-month
).map(([year, month, day]) => {
  const m = month.toString().padStart(2, '0');
  const d = day.toString().padStart(2, '0');
  return `${year}-${m}-${d}`;
});

/** Generates a valid USD amount (non-negative, max 2 decimal places) */
const validUSDAmountArb = fc.integer({ min: 0, max: 9999999 }).map((cents) => cents / 100);

/** Generates a non-empty string for denial reason text */
const nonEmptyReasonTextArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-:'.split('')),
  { minLength: 1, maxLength: 200 }
).filter((s) => s.trim().length > 0);

/** Generates a valid source format */
const sourceFormatArb = fc.constantFrom(...sourceFormats);

/** Generates a complete valid Denial_Record-like object */
const validDenialRecordFieldsArb = fc.record({
  claim_id: nonEmptyIdArb,
  patient_id: nonEmptyIdArb,
  payer_id: nonEmptyIdArb,
  denial_date: validISODateArb,
  denied_amount: validUSDAmountArb,
  raw_denial_reason_text: nonEmptyReasonTextArb,
  source_format: sourceFormatArb,
});

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Property 2: Denial_Record Schema Invariant', () => {
  it('valid inputs across all source formats always pass validation with correct types', () => {
    fc.assert(
      fc.property(validDenialRecordFieldsArb, (record) => {
        const result = validateDenialRecordFields(record);

        // All mandatory fields must pass validation
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);

        // Verify individual field type constraints
        expect(typeof record.claim_id).toBe('string');
        expect(record.claim_id.trim().length).toBeGreaterThan(0);

        expect(typeof record.patient_id).toBe('string');
        expect(record.patient_id.trim().length).toBeGreaterThan(0);

        expect(typeof record.payer_id).toBe('string');
        expect(record.payer_id.trim().length).toBeGreaterThan(0);

        expect(isValidISO8601(record.denial_date)).toBe(true);

        expect(typeof record.denied_amount).toBe('number');
        expect(record.denied_amount).toBeGreaterThanOrEqual(0);
        expect(isValidUSDAmount(record.denied_amount)).toBe(true);

        expect(typeof record.raw_denial_reason_text).toBe('string');
        expect(record.raw_denial_reason_text.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('claim_id must be non-empty string — empty/missing fails validation', () => {
    fc.assert(
      fc.property(
        validDenialRecordFieldsArb.map((r) => ({ ...r, claim_id: '' })),
        (record) => {
          const result = validateDenialRecordFields(record);
          expect(result.valid).toBe(false);
          expect(result.errors).toContain('claim_id must be a non-empty string');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('denied_amount must be non-negative with max 2 decimal places', () => {
    fc.assert(
      fc.property(validUSDAmountArb, (amount) => {
        expect(amount).toBeGreaterThanOrEqual(0);
        expect(isValidUSDAmount(amount)).toBe(true);

        // Verify max 2 decimal places
        const decimalStr = amount.toString();
        const decimalIndex = decimalStr.indexOf('.');
        if (decimalIndex !== -1) {
          expect(decimalStr.length - decimalIndex - 1).toBeLessThanOrEqual(2);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('denial_date must be valid ISO 8601', () => {
    fc.assert(
      fc.property(validISODateArb, (date) => {
        expect(isValidISO8601(date)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
