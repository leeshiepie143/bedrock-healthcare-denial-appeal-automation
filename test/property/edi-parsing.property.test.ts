/**
 * Property 1: EDI Parsing Produces Valid Denial Records
 *
 * Generate arbitrary valid EDI 835 transactions; verify extracted fields
 * match encoded values.
 *
 * Validates: Requirements 1.3, 1.4
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseEDI835 } from '@lambdas/ingestion/edi-parser';

// ─── Arbitraries ────────────────────────────────────────────────────────────

/** Generates a valid CARC group code */
const groupCodeArb = fc.constantFrom('CO', 'PR', 'OA', 'PI', 'CR');

/** Generates a valid CARC reason code (1-999) */
const reasonCodeArb = fc.integer({ min: 1, max: 999 }).map(String);

/** Generates a valid dollar amount (positive, 2 decimal places) */
const dollarAmountArb = fc.integer({ min: 1, max: 999999 }).map((cents) => cents / 100);

/** Generates a valid claim ID (alphanumeric, 5-20 chars) */
const claimIdArb = fc.stringOf(
  fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
  { minLength: 5, maxLength: 20 }
);

/** Generates a valid patient ID (alphanumeric, 5-15 chars) */
const patientIdArb = fc.stringOf(
  fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
  { minLength: 5, maxLength: 15 }
);

/** Generates a valid payer ID (alphanumeric, 5-10 chars) */
const payerIdArb = fc.stringOf(
  fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
  { minLength: 5, maxLength: 10 }
);

/** Generates a valid EDI date (CCYYMMDD) */
const ediDateArb = fc.tuple(
  fc.integer({ min: 2000, max: 2030 }),
  fc.integer({ min: 1, max: 12 }),
  fc.integer({ min: 1, max: 28 })
).map(([year, month, day]) => {
  return `${year}${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`;
});

/** Generates a charged amount that is greater than paid amount */
const amountPairArb = fc.tuple(
  fc.integer({ min: 100, max: 999999 }),
  fc.integer({ min: 0, max: 99 })
).map(([charged, paidPercent]) => {
  const chargedAmount = charged / 100;
  const paidAmount = Math.round(chargedAmount * paidPercent) / 100;
  return { charged: chargedAmount, paid: paidAmount };
});

/** Builds a valid EDI 835 transaction from components */
function buildEDI835(params: {
  claimId: string;
  patientId: string;
  payerId: string;
  ediDate: string;
  chargedAmount: number;
  paidAmount: number;
  groupCode: string;
  reasonCode: string;
  adjustmentAmount: number;
}): string {
  const segments = [
    // ISA segment (106 chars with standard delimiters)
    'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
    'GS*HP*SENDER*RECEIVER*20230101*1200*1*X*005010X221A1~',
    'ST*835*0001~',
    `N1*PR*PAYER NAME*PI*${params.payerId}~`,
    `CLP*${params.claimId}*4*${params.chargedAmount.toFixed(2)}*${params.paidAmount.toFixed(2)}*0*MC*${params.patientId}~`,
    `CAS*${params.groupCode}*${params.reasonCode}*${params.adjustmentAmount.toFixed(2)}~`,
    `DTM*232*${params.ediDate}~`,
    'SE*7*0001~',
    'GE*1*1~',
    'IEA*1*000000001~',
  ];
  return segments.join('\n');
}

// ─── Composite Arbitrary ────────────────────────────────────────────────────

const edi835InputArb = fc.record({
  claimId: claimIdArb,
  patientId: patientIdArb,
  payerId: payerIdArb,
  ediDate: ediDateArb,
  amounts: amountPairArb,
  groupCode: groupCodeArb,
  reasonCode: reasonCodeArb,
  adjustmentAmount: dollarAmountArb,
});

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Property 1: EDI Parsing Produces Valid Denial Records', () => {
  it('parseEDI835 extracts the exact values that were encoded in CLP segments', () => {
    fc.assert(
      fc.property(edi835InputArb, (input) => {
        const ediContent = buildEDI835({
          claimId: input.claimId,
          patientId: input.patientId,
          payerId: input.payerId,
          ediDate: input.ediDate,
          chargedAmount: input.amounts.charged,
          paidAmount: input.amounts.paid,
          groupCode: input.groupCode,
          reasonCode: input.reasonCode,
          adjustmentAmount: input.adjustmentAmount,
        });

        const result = parseEDI835(ediContent);

        // Verify claim_id matches CLP01
        expect(result.claim_id).toBe(input.claimId);

        // Verify patient_id matches CLP07
        expect(result.patient_id).toBe(input.patientId);

        // Verify payer_id matches N1*PR N104
        expect(result.payer_id).toBe(input.payerId);

        // Verify denied_amount = charged - paid
        const expectedDenied = Math.round((input.amounts.charged - input.amounts.paid) * 100) / 100;
        expect(result.denied_amount).toBeCloseTo(expectedDenied, 2);

        // Verify adjustment reason codes extracted from CAS segment
        expect(result.adjustment_reason_codes.length).toBeGreaterThanOrEqual(1);
        const firstArc = result.adjustment_reason_codes[0];
        expect(firstArc.group_code).toBe(input.groupCode);
        expect(firstArc.reason_code).toBe(input.reasonCode);
        expect(firstArc.amount).toBeCloseTo(input.adjustmentAmount, 2);

        // Verify denial_date is converted from CCYYMMDD to ISO 8601
        if (result.denial_date) {
          const expectedYear = input.ediDate.substring(0, 4);
          const expectedMonth = input.ediDate.substring(4, 6);
          const expectedDay = input.ediDate.substring(6, 8);
          expect(result.denial_date).toBe(`${expectedYear}-${expectedMonth}-${expectedDay}`);
        }

        // Verify raw_denial_reason_text is non-null when CAS segments exist
        expect(result.raw_denial_reason_text).not.toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it('parseEDI835 produces non-null raw_denial_reason_text from CAS segments', () => {
    fc.assert(
      fc.property(edi835InputArb, (input) => {
        const ediContent = buildEDI835({
          claimId: input.claimId,
          patientId: input.patientId,
          payerId: input.payerId,
          ediDate: input.ediDate,
          chargedAmount: input.amounts.charged,
          paidAmount: input.amounts.paid,
          groupCode: input.groupCode,
          reasonCode: input.reasonCode,
          adjustmentAmount: input.adjustmentAmount,
        });

        const result = parseEDI835(ediContent);

        // raw_denial_reason_text should contain the group code and reason code
        expect(result.raw_denial_reason_text).not.toBeNull();
        expect(result.raw_denial_reason_text!).toContain(input.groupCode);
        expect(result.raw_denial_reason_text!).toContain(input.reasonCode);
      }),
      { numRuns: 100 }
    );
  });
});
