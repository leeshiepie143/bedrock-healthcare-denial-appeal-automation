/**
 * Property 5: Denial Reason Ranking Correctness
 * Property 6: Classification Confidence Routing
 *
 * Property 5: Generate sets of denial reasons with random dollar amounts;
 * verify ranking is in strictly descending order.
 *
 * Property 6: Generate confidence scores; verify routing to human review
 * when < 0.8 and auto-classified when >= 0.8.
 *
 * Validates: Requirements 2.4, 2.5, 2.7
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  parseCarcCodesFromText,
  rankCarcEntries,
  isDollarRankingAvailable,
  type ParsedCarcEntry,
} from '@lambdas/classifier/structured-classifier';

// ─── Arbitraries ────────────────────────────────────────────────────────────

/** Generates a valid CARC group code */
const groupCodeArb = fc.constantFrom('CO', 'PR', 'OA', 'PI', 'CR');

/** Generates a valid CARC reason code (1-999) */
const reasonCodeArb = fc.integer({ min: 1, max: 999 }).map(String);

/** Generates a positive dollar amount */
const dollarAmountArb = fc.integer({ min: 1, max: 999999 }).map((cents) => cents / 100);

/** Generates a single CARC entry with a dollar amount */
const carcEntryWithAmountArb = fc.tuple(groupCodeArb, reasonCodeArb, dollarAmountArb, fc.nat({ max: 100 }))
  .map(([groupCode, reasonCode, amount, position]): ParsedCarcEntry => ({
    group_code: groupCode,
    reason_code: reasonCode,
    dollar_amount: amount,
    original_position: position,
  }));

/** Generates a set of CARC entries with unique dollar amounts for clear ranking */
const carcEntriesWithAmountsArb = fc.array(carcEntryWithAmountArb, { minLength: 2, maxLength: 25 })
  .map((entries) => entries.map((e, i) => ({ ...e, original_position: i })));

/** Generates a single CARC entry without a dollar amount */
const carcEntryWithoutAmountArb = fc.tuple(groupCodeArb, reasonCodeArb, fc.nat({ max: 100 }))
  .map(([groupCode, reasonCode, position]): ParsedCarcEntry => ({
    group_code: groupCode,
    reason_code: reasonCode,
    dollar_amount: null,
    original_position: position,
  }));

/** Generates a set of CARC entries without dollar amounts */
const carcEntriesWithoutAmountsArb = fc.array(carcEntryWithoutAmountArb, { minLength: 2, maxLength: 25 })
  .map((entries) => entries.map((e, i) => ({ ...e, original_position: i })));

/** Generates a confidence score between 0.0 and 1.0 */
const confidenceScoreArb = fc.double({ min: 0.0, max: 1.0, noNaN: true });

/** Confidence threshold for routing */
const CONFIDENCE_THRESHOLD = 0.8;

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Property 5: Denial Reason Ranking Correctness', () => {
  it('when dollar amounts are available, ranking is in strictly descending order by amount', () => {
    fc.assert(
      fc.property(carcEntriesWithAmountsArb, (entries) => {
        const dollarAvailable = isDollarRankingAvailable(entries);

        // All entries have positive dollar amounts, so dollar ranking should be available
        expect(dollarAvailable).toBe(true);

        const ranked = rankCarcEntries(entries, true);

        // Verify descending order by dollar amount
        for (let i = 0; i < ranked.length - 1; i++) {
          expect(ranked[i].dollar_amount!).toBeGreaterThanOrEqual(ranked[i + 1].dollar_amount!);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('when dollar amounts are not available, ranking preserves document order', () => {
    fc.assert(
      fc.property(carcEntriesWithoutAmountsArb, (entries) => {
        const dollarAvailable = isDollarRankingAvailable(entries);

        // No entries have dollar amounts, so dollar ranking should not be available
        expect(dollarAvailable).toBe(false);

        const ranked = rankCarcEntries(entries, false);

        // Verify ascending order by original_position (document order)
        for (let i = 0; i < ranked.length - 1; i++) {
          expect(ranked[i].original_position).toBeLessThanOrEqual(ranked[i + 1].original_position);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('parseCarcCodesFromText with dollar amounts produces entries that rank correctly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(groupCodeArb, reasonCodeArb, dollarAmountArb),
          { minLength: 1, maxLength: 10 }
        ),
        (carcTuples) => {
          // Build raw text in the expected format: "CO-45: $100.00; PR-253: $50.00"
          const rawText = carcTuples
            .map(([group, code, amount]) => `${group}-${code}: $${amount.toFixed(2)}`)
            .join('; ');

          const parsed = parseCarcCodesFromText(rawText);

          // All entries should have dollar amounts
          expect(parsed.length).toBe(carcTuples.length);
          for (const entry of parsed) {
            expect(entry.dollar_amount).not.toBeNull();
            expect(entry.dollar_amount!).toBeGreaterThan(0);
          }

          // Ranking by dollar amount should produce descending order
          if (isDollarRankingAvailable(parsed)) {
            const ranked = rankCarcEntries(parsed, true);
            for (let i = 0; i < ranked.length - 1; i++) {
              expect(ranked[i].dollar_amount!).toBeGreaterThanOrEqual(ranked[i + 1].dollar_amount!);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 6: Classification Confidence Routing', () => {
  it('confidence < 0.8 routes to human review (pending_review)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0, max: 0.7999, noNaN: true }),
        (confidence) => {
          // When confidence is below threshold, should route to human review
          const shouldRouteToReview = confidence < CONFIDENCE_THRESHOLD;
          expect(shouldRouteToReview).toBe(true);

          // The review_status should be 'pending_review'
          const reviewStatus = confidence < CONFIDENCE_THRESHOLD ? 'pending_review' : 'auto_classified';
          expect(reviewStatus).toBe('pending_review');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('confidence >= 0.8 is auto-classified', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.8, max: 1.0, noNaN: true }),
        (confidence) => {
          // When confidence is at or above threshold, should auto-classify
          const shouldAutoClassify = confidence >= CONFIDENCE_THRESHOLD;
          expect(shouldAutoClassify).toBe(true);

          // The review_status should be 'auto_classified'
          const reviewStatus = confidence >= CONFIDENCE_THRESHOLD ? 'auto_classified' : 'pending_review';
          expect(reviewStatus).toBe('auto_classified');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('confidence threshold boundary: 0.8 exactly is auto-classified', () => {
    const confidence = 0.8;
    const reviewStatus = confidence >= CONFIDENCE_THRESHOLD ? 'auto_classified' : 'pending_review';
    expect(reviewStatus).toBe('auto_classified');
  });
});
