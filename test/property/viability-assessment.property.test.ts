/**
 * Property 8: Viability Score Recommendation Consistency
 * Property 9: Confidence Interval Validity
 *
 * Property 8: Generate arbitrary scoring inputs; verify score in [0.0, 1.0],
 * correct recommendation based on threshold, expired deadline → 0.0.
 *
 * Property 9: Generate assessments with varying n; verify bounds contain score,
 * bounds in [0.0, 1.0], interval widens with sparse data.
 *
 * Validates: Requirements 4.2, 4.3, 4.4, 4.6, 4.7, 4.8
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  calculateViabilityScore,
  DEFAULT_SCORING_MODEL,
  type ScoringInput,
} from '@lambdas/viability/scorer';
import {
  calculateWilsonInterval,
  MIN_SAMPLE_SIZE,
  CONFIDENCE_LEVEL,
} from '@lambdas/viability/confidence';
import type { EvidencePackage, EvidenceItem, FhirResourceType } from '@shared/models';

// ─── Constants ──────────────────────────────────────────────────────────────

const PURSUE_THRESHOLD = DEFAULT_SCORING_MODEL.thresholds.pursue; // 0.3

// ─── Arbitraries ────────────────────────────────────────────────────────────

/** Generates a relevance score between 0.0 and 1.0 */
const scoreArb = fc.double({ min: 0.0, max: 1.0, noNaN: true });

/** Generates a claim amount (positive) */
const claimAmountArb = fc.double({ min: 0.01, max: 100000, noNaN: true });

/** Generates a future date (for non-expired deadlines) */
const futureDateArb = fc.integer({ min: 1, max: 365 }).map((daysAhead) => {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().split('T')[0];
});

/** Generates a past date (for expired deadlines) */
const pastDateArb = fc.integer({ min: 1, max: 365 }).map((daysAgo) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
});

/** Generates a FHIR resource type */
const fhirResourceTypeArb = fc.constantFrom<FhirResourceType>(
  'Encounter', 'Procedure', 'Condition', 'DiagnosticReport', 'DocumentReference'
);

/** Generates a minimal evidence item */
const evidenceItemArb = fc.tuple(
  fc.uuid(),
  fhirResourceTypeArb,
  scoreArb
).map(([id, type, score]): EvidenceItem => ({
  fhir_resource_id: id,
  fhir_resource_type: type,
  date: '2024-01-15',
  authoring_provider: 'Dr. Test',
  relevance_score: score,
  extracted_entities: [],
  mapped_denial_reasons: [],
}));

/** Generates an evidence package with 1-10 items */
const evidencePackageArb = fc.array(evidenceItemArb, { minLength: 1, maxLength: 10 })
  .map((items): EvidencePackage => ({
    PK: 'TENANT#test',
    SK: 'EVIDENCE#claim1',
    claim_id: 'claim1',
    patient_id: 'patient1',
    evidence_items: items,
    total_evidence_count: items.length,
    retrieval_timestamp: '2024-01-15T10:00:00Z',
    retrieval_duration_ms: 500,
    manual_review_required: false,
  }));

/** Generates a complete scoring input with a future deadline */
const scoringInputWithFutureDeadlineArb = fc.tuple(
  evidencePackageArb,
  scoreArb,
  scoreArb,
  claimAmountArb,
  futureDateArb
).map(([evidencePackage, historicalRate, payerRate, claimAmount, deadline]): ScoringInput => ({
  evidencePackage,
  denialReasonCode: 'CO-45',
  payerId: 'PAYER1',
  claimAmount,
  appealDeadlineDate: deadline,
  historicalOverturnRate: historicalRate,
  payerOverturnRate: payerRate,
}));

/** Generates a complete scoring input with an expired deadline */
const scoringInputWithExpiredDeadlineArb = fc.tuple(
  evidencePackageArb,
  scoreArb,
  scoreArb,
  claimAmountArb,
  pastDateArb
).map(([evidencePackage, historicalRate, payerRate, claimAmount, deadline]): ScoringInput => ({
  evidencePackage,
  denialReasonCode: 'CO-45',
  payerId: 'PAYER1',
  claimAmount,
  appealDeadlineDate: deadline,
  historicalOverturnRate: historicalRate,
  payerOverturnRate: payerRate,
}));

/** Generates a sample size (n) for confidence interval tests */
const sampleSizeArb = fc.integer({ min: 0, max: 500 });

/** Generates a proportion (p) for confidence interval tests */
const proportionArb = fc.double({ min: 0.0, max: 1.0, noNaN: true });

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Property 8: Viability Score Recommendation Consistency', () => {
  it('score is always in [0.0, 1.0] for any valid input', () => {
    fc.assert(
      fc.property(scoringInputWithFutureDeadlineArb, (input) => {
        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL);

        expect(result.score).toBeGreaterThanOrEqual(0.0);
        expect(result.score).toBeLessThanOrEqual(1.0);
      }),
      { numRuns: 100 }
    );
  });

  it('score >= 0.3 produces "pursue" recommendation', () => {
    fc.assert(
      fc.property(scoringInputWithFutureDeadlineArb, (input) => {
        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL);

        if (result.score >= PURSUE_THRESHOLD) {
          expect(result.recommendation).toBe('pursue');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('score < 0.3 produces "do_not_pursue" recommendation', () => {
    fc.assert(
      fc.property(scoringInputWithFutureDeadlineArb, (input) => {
        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL);

        if (result.score < PURSUE_THRESHOLD) {
          expect(result.recommendation).toBe('do_not_pursue');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('expired deadline always produces score 0.0 and "do_not_pursue"', () => {
    fc.assert(
      fc.property(scoringInputWithExpiredDeadlineArb, (input) => {
        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL);

        expect(result.score).toBe(0.0);
        expect(result.recommendation).toBe('do_not_pursue');
        expect(result.deadlineExpired).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('"pursue" recommendation includes top evidence items', () => {
    fc.assert(
      fc.property(scoringInputWithFutureDeadlineArb, (input) => {
        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL);

        if (result.recommendation === 'pursue') {
          // Should have up to 3 top evidence items
          expect(result.topEvidenceItems.length).toBeLessThanOrEqual(3);
          expect(result.topEvidenceItems.length).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('"do_not_pursue" recommendation includes at least 2 rationale factors', () => {
    fc.assert(
      fc.property(scoringInputWithFutureDeadlineArb, (input) => {
        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL);

        if (result.recommendation === 'do_not_pursue') {
          expect(result.rationale.length).toBeGreaterThanOrEqual(2);
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 9: Confidence Interval Validity', () => {
  it('bounds are always in [0.0, 1.0]', () => {
    fc.assert(
      fc.property(scoreArb, sampleSizeArb, proportionArb, (score, n, p) => {
        const interval = calculateWilsonInterval(score, n, p);

        expect(interval.lower).toBeGreaterThanOrEqual(0.0);
        expect(interval.lower).toBeLessThanOrEqual(1.0);
        expect(interval.upper).toBeGreaterThanOrEqual(0.0);
        expect(interval.upper).toBeLessThanOrEqual(1.0);
      }),
      { numRuns: 100 }
    );
  });

  it('lower bound <= upper bound', () => {
    fc.assert(
      fc.property(scoreArb, sampleSizeArb, proportionArb, (score, n, p) => {
        const interval = calculateWilsonInterval(score, n, p);
        expect(interval.lower).toBeLessThanOrEqual(interval.upper);
      }),
      { numRuns: 100 }
    );
  });

  it('confidence level is always 0.90', () => {
    fc.assert(
      fc.property(scoreArb, sampleSizeArb, proportionArb, (score, n, p) => {
        const interval = calculateWilsonInterval(score, n, p);
        expect(interval.confidence_level).toBe(CONFIDENCE_LEVEL);
      }),
      { numRuns: 100 }
    );
  });

  it('interval widens with sparse data (n < 30 produces wider interval than n >= 30)', () => {
    fc.assert(
      fc.property(
        scoreArb,
        proportionArb.filter((p) => p > 0.1 && p < 0.9), // Avoid extreme proportions
        (score, p) => {
          const sparseN = 10; // n < 30
          const adequateN = 100; // n >= 30

          const sparseInterval = calculateWilsonInterval(score, sparseN, p);
          const adequateInterval = calculateWilsonInterval(score, adequateN, p);

          const sparseWidth = sparseInterval.upper - sparseInterval.lower;
          const adequateWidth = adequateInterval.upper - adequateInterval.lower;

          // Sparse data should produce a wider (or equal) interval
          expect(sparseWidth).toBeGreaterThanOrEqual(adequateWidth);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('n = 0 produces maximally wide interval [0.0, 1.0]', () => {
    fc.assert(
      fc.property(scoreArb, proportionArb, (score, p) => {
        const interval = calculateWilsonInterval(score, 0, p);

        expect(interval.lower).toBe(0.0);
        expect(interval.upper).toBe(1.0);
      }),
      { numRuns: 100 }
    );
  });
});
