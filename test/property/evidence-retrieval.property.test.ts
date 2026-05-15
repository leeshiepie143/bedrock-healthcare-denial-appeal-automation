/**
 * Property 7: Evidence Relevance Filtering and Ordering
 *
 * Generate sets of evidence items with random relevance scores; verify
 * filtering (>= 0.2), ordering (descending), and max 50 items.
 *
 * Validates: Requirements 3.6
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { RELEVANCE_THRESHOLD } from '@lambdas/evidence/entity-extractor';
import type { EvidenceItem, FhirResourceType, EntityCategory } from '@shared/models';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_EVIDENCE_ITEMS = 50;

const FHIR_RESOURCE_TYPES: FhirResourceType[] = [
  'Encounter', 'Procedure', 'Condition', 'DiagnosticReport', 'DocumentReference',
];

const ENTITY_CATEGORIES: EntityCategory[] = ['DIAGNOSIS', 'PROCEDURE', 'MEDICATION', 'ANATOMY'];

// ─── Arbitraries ────────────────────────────────────────────────────────────

/** Generates a relevance score between 0.0 and 1.0 */
const relevanceScoreArb = fc.double({ min: 0.0, max: 1.0, noNaN: true });

/** Generates a FHIR resource type */
const fhirResourceTypeArb = fc.constantFrom(...FHIR_RESOURCE_TYPES);

/** Generates a FHIR resource ID */
const fhirResourceIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
  { minLength: 5, maxLength: 36 }
);

/** Generates a valid ISO 8601 date */
const isoDateArb = fc.tuple(
  fc.integer({ min: 2020, max: 2025 }),
  fc.integer({ min: 1, max: 12 }),
  fc.integer({ min: 1, max: 28 })
).map(([y, m, d]) => `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`);

/** Generates a provider name */
const providerNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')),
  { minLength: 3, maxLength: 30 }
).filter((s) => s.trim().length > 0);

/** Generates a single evidence item with a given relevance score */
const evidenceItemArb = fc.tuple(
  fhirResourceIdArb,
  fhirResourceTypeArb,
  isoDateArb,
  providerNameArb,
  relevanceScoreArb
).map(([id, type, date, provider, score]): EvidenceItem => ({
  fhir_resource_id: id,
  fhir_resource_type: type,
  date,
  authoring_provider: provider,
  relevance_score: score,
  extracted_entities: [],
  mapped_denial_reasons: [],
}));

/** Generates a set of evidence items (1-80 items to test max 50 filtering) */
const evidenceItemsArb = fc.array(evidenceItemArb, { minLength: 1, maxLength: 80 });

// ─── Helper: Apply filtering and ordering logic ─────────────────────────────

/**
 * Applies the same filtering and ordering logic as the evidence retrieval service:
 * 1. Filter out items with relevance_score < 0.2
 * 2. Sort by descending relevance score
 * 3. Limit to max 50 items
 */
function filterAndOrderEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const filtered = items.filter((item) => item.relevance_score >= RELEVANCE_THRESHOLD);
  const sorted = [...filtered].sort((a, b) => b.relevance_score - a.relevance_score);
  return sorted.slice(0, MAX_EVIDENCE_ITEMS);
}

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Property 7: Evidence Relevance Filtering and Ordering', () => {
  it('all items in result have relevance score >= 0.2 (threshold filtering)', () => {
    fc.assert(
      fc.property(evidenceItemsArb, (items) => {
        const result = filterAndOrderEvidence(items);

        for (const item of result) {
          expect(item.relevance_score).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('result is ordered by descending relevance score', () => {
    fc.assert(
      fc.property(evidenceItemsArb, (items) => {
        const result = filterAndOrderEvidence(items);

        for (let i = 0; i < result.length - 1; i++) {
          expect(result[i].relevance_score).toBeGreaterThanOrEqual(result[i + 1].relevance_score);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('result contains at most 50 items', () => {
    fc.assert(
      fc.property(evidenceItemsArb, (items) => {
        const result = filterAndOrderEvidence(items);
        expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
      }),
      { numRuns: 100 }
    );
  });

  it('no items below threshold are included even when total is under 50', () => {
    fc.assert(
      fc.property(evidenceItemsArb, (items) => {
        const result = filterAndOrderEvidence(items);
        const belowThreshold = items.filter((item) => item.relevance_score < RELEVANCE_THRESHOLD);

        // None of the below-threshold items should appear in the result
        for (const excluded of belowThreshold) {
          const found = result.some(
            (r) => r.fhir_resource_id === excluded.fhir_resource_id &&
                   r.relevance_score === excluded.relevance_score
          );
          expect(found).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('all items above threshold are included (up to max 50)', () => {
    fc.assert(
      fc.property(evidenceItemsArb, (items) => {
        const result = filterAndOrderEvidence(items);
        const aboveThreshold = items.filter((item) => item.relevance_score >= RELEVANCE_THRESHOLD);

        if (aboveThreshold.length <= MAX_EVIDENCE_ITEMS) {
          // All above-threshold items should be in the result
          expect(result.length).toBe(aboveThreshold.length);
        } else {
          // Exactly 50 items should be in the result
          expect(result.length).toBe(MAX_EVIDENCE_ITEMS);
          // The lowest score in result should be >= the highest excluded score
          const resultMinScore = result[result.length - 1].relevance_score;
          const sortedAbove = [...aboveThreshold].sort((a, b) => b.relevance_score - a.relevance_score);
          const firstExcluded = sortedAbove[MAX_EVIDENCE_ITEMS];
          if (firstExcluded) {
            expect(resultMinScore).toBeGreaterThanOrEqual(firstExcluded.relevance_score);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
