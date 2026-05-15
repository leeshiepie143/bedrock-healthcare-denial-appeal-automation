/**
 * Property 3: Missing Mandatory Field Detection
 * Property 4: Duplicate Detection Idempotence
 *
 * Property 3: Generate documents with random subsets of fields missing;
 * verify quarantine and exact missing field reporting.
 *
 * Property 4: Generate duplicate (claim_id, source_format) pairs;
 * verify deduplication key is identical.
 *
 * Validates: Requirements 1.7, 1.8
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateDenialRecordFields } from '@shared/validation';
import { buildDeduplicationKey } from '@lambdas/ingestion/edi-parser';
import type { SourceFormat } from '@shared/models';

// ─── Arbitraries ────────────────────────────────────────────────────────────

const sourceFormats: SourceFormat[] = ['pdf', 'tiff', 'png', 'jpeg', 'edi_835', 'edi_277'];

/** Generates a non-empty alphanumeric string for IDs */
const nonEmptyIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 50 }
);

/** Generates a valid ISO 8601 date string */
const validISODateArb = fc.tuple(
  fc.integer({ min: 2000, max: 2030 }),
  fc.integer({ min: 1, max: 12 }),
  fc.integer({ min: 1, max: 28 })
).map(([year, month, day]) => {
  const m = month.toString().padStart(2, '0');
  const d = day.toString().padStart(2, '0');
  return `${year}-${m}-${d}`;
});

/** Generates a valid USD amount */
const validUSDAmountArb = fc.integer({ min: 0, max: 9999999 }).map((cents) => cents / 100);

/** Generates a non-empty reason text */
const nonEmptyReasonTextArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
  { minLength: 1, maxLength: 100 }
).filter((s) => s.trim().length > 0);

/** Generates a source format */
const sourceFormatArb = fc.constantFrom(...sourceFormats);

/** The mandatory field names that can be missing */
const mandatoryFields = ['claim_id', 'patient_id', 'payer_id', 'denial_date', 'denied_amount', 'raw_denial_reason_text'] as const;

/** Generates a non-empty subset of mandatory fields to remove */
const missingFieldsSubsetArb = fc.subarray([...mandatoryFields], { minLength: 1, maxLength: 6 });

/** Generates a complete valid record */
const validRecordArb = fc.record({
  claim_id: nonEmptyIdArb,
  patient_id: nonEmptyIdArb,
  payer_id: nonEmptyIdArb,
  denial_date: validISODateArb,
  denied_amount: validUSDAmountArb,
  raw_denial_reason_text: nonEmptyReasonTextArb,
});

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Property 3: Missing Mandatory Field Detection', () => {
  it('documents with random subsets of fields missing report exactly those fields as errors', () => {
    fc.assert(
      fc.property(validRecordArb, missingFieldsSubsetArb, (record, fieldsToRemove) => {
        // Create a record with some fields removed/invalidated
        const incompleteRecord: Record<string, unknown> = { ...record };

        for (const field of fieldsToRemove) {
          if (field === 'denied_amount') {
            // Set to invalid value (negative)
            incompleteRecord[field] = -1;
          } else if (field === 'denial_date') {
            // Set to invalid date
            incompleteRecord[field] = 'not-a-date';
          } else {
            // Set to empty string for string fields
            incompleteRecord[field] = '';
          }
        }

        const result = validateDenialRecordFields(incompleteRecord as {
          claim_id?: unknown;
          patient_id?: unknown;
          payer_id?: unknown;
          denial_date?: unknown;
          denied_amount?: unknown;
          raw_denial_reason_text?: unknown;
        });

        // Validation must fail
        expect(result.valid).toBe(false);

        // The number of errors should match the number of removed fields
        expect(result.errors.length).toBe(fieldsToRemove.length);

        // Each removed field should have a corresponding error message
        for (const field of fieldsToRemove) {
          const hasError = result.errors.some((err) => err.includes(field));
          expect(hasError).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('a fully valid record produces no errors', () => {
    fc.assert(
      fc.property(validRecordArb, (record) => {
        const result = validateDenialRecordFields(record);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 4: Duplicate Detection Idempotence', () => {
  it('same (claim_id, source_format) pair always produces identical deduplication key', () => {
    fc.assert(
      fc.property(nonEmptyIdArb, nonEmptyIdArb, sourceFormatArb, (tenantId, claimId, sourceFormat) => {
        const key1 = buildDeduplicationKey(tenantId, claimId, sourceFormat);
        const key2 = buildDeduplicationKey(tenantId, claimId, sourceFormat);

        // Keys must be identical for the same inputs
        expect(key1.PK).toBe(key2.PK);
        expect(key1.SK).toBe(key2.SK);
        expect(key1.tableName).toBe(key2.tableName);

        // PK must contain tenant ID
        expect(key1.PK).toContain(tenantId);

        // SK must contain claim ID and source format
        expect(key1.SK).toContain(claimId);
        expect(key1.SK).toContain(sourceFormat);
      }),
      { numRuns: 100 }
    );
  });

  it('different (claim_id, source_format) pairs produce different deduplication keys', () => {
    fc.assert(
      fc.property(
        nonEmptyIdArb,
        nonEmptyIdArb,
        nonEmptyIdArb.filter((id) => id.length >= 2),
        sourceFormatArb,
        sourceFormatArb,
        (tenantId, claimId1, claimId2, format1, format2) => {
          // Only test when inputs actually differ
          fc.pre(claimId1 !== claimId2 || format1 !== format2);

          const key1 = buildDeduplicationKey(tenantId, claimId1, format1);
          const key2 = buildDeduplicationKey(tenantId, claimId2, format2);

          // At least the SK should differ when claim_id or format differs
          if (claimId1 !== claimId2 || format1 !== format2) {
            expect(key1.SK).not.toBe(key2.SK);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
