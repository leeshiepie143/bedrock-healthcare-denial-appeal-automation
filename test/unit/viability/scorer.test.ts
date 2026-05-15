import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateViabilityScore,
  calculateDaysRemaining,
  calculateEvidenceScore,
  clearModelCache,
  DEFAULT_SCORING_MODEL,
  type ScoringInput,
  type ScoringModel,
} from '@lambdas/viability/scorer';
import type { EvidencePackage, EvidenceItem } from '@shared/models';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeEvidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    fhir_resource_id: overrides.fhir_resource_id ?? `fhir-${Math.random().toString(36).slice(2, 8)}`,
    fhir_resource_type: overrides.fhir_resource_type ?? 'Encounter',
    date: overrides.date ?? '2024-01-15',
    authoring_provider: overrides.authoring_provider ?? 'Dr. Smith',
    relevance_score: overrides.relevance_score ?? 0.7,
    extracted_entities: overrides.extracted_entities ?? [],
    mapped_denial_reasons: overrides.mapped_denial_reasons ?? ['CO-50'],
  };
}

function makeEvidencePackage(items: EvidenceItem[] = []): EvidencePackage {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'EVIDENCE#claim-001',
    claim_id: 'claim-001',
    patient_id: 'patient-001',
    evidence_items: items,
    total_evidence_count: items.length,
    retrieval_timestamp: '2024-01-20T10:00:00Z',
    retrieval_duration_ms: 1500,
    manual_review_required: false,
  };
}

function makeScoringInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    evidencePackage: overrides.evidencePackage ?? makeEvidencePackage([
      makeEvidenceItem({ relevance_score: 0.8 }),
      makeEvidenceItem({ relevance_score: 0.6 }),
      makeEvidenceItem({ relevance_score: 0.7 }),
    ]),
    denialReasonCode: overrides.denialReasonCode ?? 'CO-50',
    payerId: overrides.payerId ?? 'payer-001',
    claimAmount: overrides.claimAmount ?? 5000,
    appealDeadlineDate: overrides.appealDeadlineDate ?? '2024-03-01',
    historicalOverturnRate: overrides.historicalOverturnRate ?? 0.6,
    payerOverturnRate: overrides.payerOverturnRate ?? 0.5,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Viability Scorer', () => {
  beforeEach(() => {
    clearModelCache();
  });

  describe('calculateDaysRemaining', () => {
    it('should return positive days when deadline is in the future', () => {
      const currentDate = new Date(Date.UTC(2024, 0, 15)); // Jan 15, 2024 UTC
      const result = calculateDaysRemaining('2024-02-15', currentDate);
      expect(result).toBe(31);
    });

    it('should return 0 when deadline is today', () => {
      const currentDate = new Date(Date.UTC(2024, 0, 15));
      const result = calculateDaysRemaining('2024-01-15', currentDate);
      expect(result).toBe(0);
    });

    it('should return negative days when deadline has passed', () => {
      const currentDate = new Date(Date.UTC(2024, 1, 15)); // Feb 15, 2024 UTC
      const result = calculateDaysRemaining('2024-01-15', currentDate);
      expect(result).toBe(-31);
    });

    it('should return 1 when deadline is tomorrow', () => {
      const currentDate = new Date(Date.UTC(2024, 0, 14));
      const result = calculateDaysRemaining('2024-01-15', currentDate);
      expect(result).toBe(1);
    });
  });

  describe('calculateEvidenceScore', () => {
    it('should return 0.0 for empty evidence package', () => {
      const pkg = makeEvidencePackage([]);
      expect(calculateEvidenceScore(pkg)).toBe(0.0);
    });

    it('should return the average relevance score', () => {
      const pkg = makeEvidencePackage([
        makeEvidenceItem({ relevance_score: 0.8 }),
        makeEvidenceItem({ relevance_score: 0.6 }),
        makeEvidenceItem({ relevance_score: 0.4 }),
      ]);
      const result = calculateEvidenceScore(pkg);
      expect(result).toBeCloseTo(0.6, 5);
    });

    it('should handle a single evidence item', () => {
      const pkg = makeEvidencePackage([
        makeEvidenceItem({ relevance_score: 0.9 }),
      ]);
      expect(calculateEvidenceScore(pkg)).toBeCloseTo(0.9, 5);
    });
  });

  describe('calculateViabilityScore', () => {
    const currentDate = new Date(Date.UTC(2024, 0, 15)); // Jan 15, 2024 UTC

    describe('expired deadlines', () => {
      it('should return score 0.0 when deadline has passed', () => {
        const input = makeScoringInput({
          appealDeadlineDate: '2024-01-10', // 5 days ago
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.score).toBe(0.0);
        expect(result.recommendation).toBe('do_not_pursue');
        expect(result.deadlineExpired).toBe(true);
        expect(result.topEvidenceItems).toEqual([]);
      });

      it('should return score 0.0 when deadline is today (0 days remaining)', () => {
        const input = makeScoringInput({
          appealDeadlineDate: '2024-01-15', // today
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.score).toBe(0.0);
        expect(result.recommendation).toBe('do_not_pursue');
        expect(result.deadlineExpired).toBe(true);
      });

      it('should provide at least 2 negative rationale factors for expired deadlines', () => {
        const input = makeScoringInput({
          appealDeadlineDate: '2024-01-10',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.rationale.length).toBeGreaterThanOrEqual(2);
        expect(result.rationale.every(r => r.impact === 'negative')).toBe(true);
      });
    });

    describe('score calculation', () => {
      it('should produce a score between 0.0 and 1.0', () => {
        const input = makeScoringInput({
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.score).toBeGreaterThanOrEqual(0.0);
        expect(result.score).toBeLessThanOrEqual(1.0);
      });

      it('should calculate correct weighted score with known inputs', () => {
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 0.8 }),
          ]),
          historicalOverturnRate: 0.7,
          payerOverturnRate: 0.5,
          claimAmount: 5000,
          appealDeadlineDate: '2024-04-15', // well beyond 60 days → factor = 1.0
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        // Manual calculation:
        // historical_overturn_rate: 0.30 * 0.7 = 0.21
        // evidence_score: 0.25 * 0.8 = 0.20
        // days_remaining_factor: 0.15 * 1.0 = 0.15 (>60 days, clamped)
        // claim_amount_factor: 0.15 * 0.5 = 0.075
        // payer_overturn_rate: 0.15 * 0.5 = 0.075
        // Total: 0.21 + 0.20 + 0.15 + 0.075 + 0.075 = 0.71
        expect(result.score).toBeCloseTo(0.71, 2);
      });

      it('should clamp score to 1.0 when all factors are maxed', () => {
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 1.0 }),
          ]),
          historicalOverturnRate: 1.0,
          payerOverturnRate: 1.0,
          claimAmount: 20000, // > 10000, clamped to 1.0
          appealDeadlineDate: '2024-04-15', // > 60 days, clamped to 1.0
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        // All factors at 1.0, sum of weights = 1.0
        expect(result.score).toBe(1.0);
      });

      it('should produce score near 0.0 when all factors are minimal', () => {
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([]),
          historicalOverturnRate: 0.0,
          payerOverturnRate: 0.0,
          claimAmount: 0,
          appealDeadlineDate: '2024-01-16', // 1 day remaining
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        // days_remaining_factor: min(1/60, 1.0) ≈ 0.0167
        // Only contribution: 0.15 * 0.0167 ≈ 0.0025
        expect(result.score).toBeLessThan(0.01);
        expect(result.score).toBeGreaterThanOrEqual(0.0);
        expect(result.deadlineExpired).toBe(false);
      });

      it('should normalize days_remaining_factor with min(days/60, 1.0)', () => {
        // 30 days remaining → factor = 30/60 = 0.5
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 0.0 }),
          ]),
          historicalOverturnRate: 0.0,
          payerOverturnRate: 0.0,
          claimAmount: 0,
          appealDeadlineDate: '2024-02-14', // 30 days from Jan 15
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        // Only days_remaining contributes: 0.15 * (30/60) = 0.15 * 0.5 = 0.075
        expect(result.score).toBeCloseTo(0.075, 2);
      });

      it('should normalize claim_amount_factor with min(amount/10000, 1.0)', () => {
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 0.0 }),
          ]),
          historicalOverturnRate: 0.0,
          payerOverturnRate: 0.0,
          claimAmount: 15000, // > 10000, clamped to 1.0
          appealDeadlineDate: '2024-04-15', // > 60 days, factor = 1.0
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        // claim_amount_factor: 0.15 * 1.0 = 0.15
        // days_remaining_factor: 0.15 * 1.0 = 0.15 (>60 days)
        // Total: 0.15 + 0.15 = 0.30
        expect(result.score).toBeCloseTo(0.30, 2);
      });
    });

    describe('recommendation logic', () => {
      it('should recommend "pursue" when score >= 0.3', () => {
        const input = makeScoringInput({
          historicalOverturnRate: 0.6,
          payerOverturnRate: 0.5,
          claimAmount: 5000,
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.score).toBeGreaterThanOrEqual(0.3);
        expect(result.recommendation).toBe('pursue');
      });

      it('should recommend "do_not_pursue" when score < 0.3', () => {
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 0.1 }),
          ]),
          historicalOverturnRate: 0.1,
          payerOverturnRate: 0.1,
          claimAmount: 500,
          appealDeadlineDate: '2024-01-20', // 5 days
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.score).toBeLessThan(0.3);
        expect(result.recommendation).toBe('do_not_pursue');
      });

      it('should recommend "pursue" at exactly the threshold boundary', () => {
        // Use a custom model to test exact boundary
        const customModel: ScoringModel = {
          weights: {
            historical_overturn_rate: 1.0,
            evidence_score: 0.0,
            days_remaining_factor: 0.0,
            claim_amount_factor: 0.0,
            payer_overturn_rate: 0.0,
          },
          thresholds: { pursue: 0.3, high_confidence: 0.7 },
          version: '1.0.0',
          last_calibrated: '2024-01-01T00:00:00Z',
        };

        const input = makeScoringInput({
          historicalOverturnRate: 0.3, // exactly at threshold
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, customModel, currentDate);

        expect(result.score).toBeCloseTo(0.3, 5);
        expect(result.recommendation).toBe('pursue');
      });
    });

    describe('top evidence items (pursue)', () => {
      it('should return up to 3 evidence items sorted by relevance for "pursue"', () => {
        const items = [
          makeEvidenceItem({ fhir_resource_id: 'fhir-1', relevance_score: 0.5 }),
          makeEvidenceItem({ fhir_resource_id: 'fhir-2', relevance_score: 0.9 }),
          makeEvidenceItem({ fhir_resource_id: 'fhir-3', relevance_score: 0.7 }),
          makeEvidenceItem({ fhir_resource_id: 'fhir-4', relevance_score: 0.8 }),
        ];

        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage(items),
          historicalOverturnRate: 0.8,
          payerOverturnRate: 0.7,
          claimAmount: 8000,
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.recommendation).toBe('pursue');
        expect(result.topEvidenceItems).toHaveLength(3);
        expect(result.topEvidenceItems).toEqual(['fhir-2', 'fhir-4', 'fhir-3']);
      });

      it('should return fewer than 3 items if evidence package has fewer', () => {
        const items = [
          makeEvidenceItem({ fhir_resource_id: 'fhir-1', relevance_score: 0.9 }),
          makeEvidenceItem({ fhir_resource_id: 'fhir-2', relevance_score: 0.8 }),
        ];

        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage(items),
          historicalOverturnRate: 0.8,
          payerOverturnRate: 0.7,
          claimAmount: 8000,
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.recommendation).toBe('pursue');
        expect(result.topEvidenceItems).toHaveLength(2);
        expect(result.topEvidenceItems).toEqual(['fhir-1', 'fhir-2']);
      });

      it('should return empty array for "pursue" with no evidence items', () => {
        // Use custom model to force pursue with no evidence
        const customModel: ScoringModel = {
          weights: {
            historical_overturn_rate: 0.5,
            evidence_score: 0.0,
            days_remaining_factor: 0.0,
            claim_amount_factor: 0.0,
            payer_overturn_rate: 0.5,
          },
          thresholds: { pursue: 0.3, high_confidence: 0.7 },
          version: '1.0.0',
          last_calibrated: '2024-01-01T00:00:00Z',
        };

        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([]),
          historicalOverturnRate: 0.8,
          payerOverturnRate: 0.7,
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, customModel, currentDate);

        expect(result.recommendation).toBe('pursue');
        expect(result.topEvidenceItems).toEqual([]);
      });
    });

    describe('negative factors (do not pursue)', () => {
      it('should provide at least 2 negative factors for "do not pursue"', () => {
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 0.1 }),
          ]),
          historicalOverturnRate: 0.05,
          payerOverturnRate: 0.05,
          claimAmount: 200,
          appealDeadlineDate: '2024-01-20', // 5 days
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.recommendation).toBe('do_not_pursue');
        expect(result.rationale.length).toBeGreaterThanOrEqual(2);
        expect(result.rationale.every(r => r.impact === 'negative')).toBe(true);
      });

      it('should return empty topEvidenceItems for "do not pursue"', () => {
        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 0.1 }),
          ]),
          historicalOverturnRate: 0.05,
          payerOverturnRate: 0.05,
          claimAmount: 200,
          appealDeadlineDate: '2024-01-20',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.recommendation).toBe('do_not_pursue');
        expect(result.topEvidenceItems).toEqual([]);
      });
    });

    describe('model version', () => {
      it('should include the model version in the result', () => {
        const input = makeScoringInput({ appealDeadlineDate: '2024-03-15' });
        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.modelVersion).toBe('1.0.0');
      });

      it('should use custom model version when provided', () => {
        const customModel: ScoringModel = {
          ...DEFAULT_SCORING_MODEL,
          version: '2.1.0',
        };

        const input = makeScoringInput({ appealDeadlineDate: '2024-03-15' });
        const result = calculateViabilityScore(input, customModel, currentDate);

        expect(result.modelVersion).toBe('2.1.0');
      });
    });

    describe('custom model weights', () => {
      it('should use custom weights for scoring', () => {
        const customModel: ScoringModel = {
          weights: {
            historical_overturn_rate: 0.5,
            evidence_score: 0.5,
            days_remaining_factor: 0.0,
            claim_amount_factor: 0.0,
            payer_overturn_rate: 0.0,
          },
          thresholds: { pursue: 0.3, high_confidence: 0.7 },
          version: '2.0.0',
          last_calibrated: '2024-06-01T00:00:00Z',
        };

        const input = makeScoringInput({
          evidencePackage: makeEvidencePackage([
            makeEvidenceItem({ relevance_score: 0.6 }),
          ]),
          historicalOverturnRate: 0.8,
          payerOverturnRate: 0.0,
          claimAmount: 0,
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, customModel, currentDate);

        // 0.5 * 0.8 + 0.5 * 0.6 = 0.4 + 0.3 = 0.7
        expect(result.score).toBeCloseTo(0.7, 5);
      });

      it('should use custom threshold for recommendation', () => {
        const customModel: ScoringModel = {
          weights: {
            historical_overturn_rate: 1.0,
            evidence_score: 0.0,
            days_remaining_factor: 0.0,
            claim_amount_factor: 0.0,
            payer_overturn_rate: 0.0,
          },
          thresholds: { pursue: 0.5, high_confidence: 0.8 },
          version: '2.0.0',
          last_calibrated: '2024-06-01T00:00:00Z',
        };

        const input = makeScoringInput({
          historicalOverturnRate: 0.4, // below custom threshold of 0.5
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, customModel, currentDate);

        expect(result.score).toBeCloseTo(0.4, 5);
        expect(result.recommendation).toBe('do_not_pursue');
      });
    });

    describe('edge cases', () => {
      it('should handle input values above 1.0 by clamping', () => {
        const input = makeScoringInput({
          historicalOverturnRate: 1.5, // invalid but should be clamped
          payerOverturnRate: 2.0, // invalid but should be clamped
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.score).toBeGreaterThanOrEqual(0.0);
        expect(result.score).toBeLessThanOrEqual(1.0);
      });

      it('should handle negative input values by clamping to 0', () => {
        const input = makeScoringInput({
          historicalOverturnRate: -0.5,
          payerOverturnRate: -0.3,
          claimAmount: -1000,
          appealDeadlineDate: '2024-03-15',
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.score).toBeGreaterThanOrEqual(0.0);
        expect(result.score).toBeLessThanOrEqual(1.0);
      });

      it('should handle deadline exactly 1 day in the future', () => {
        const input = makeScoringInput({
          appealDeadlineDate: '2024-01-16', // 1 day from currentDate
        });

        const result = calculateViabilityScore(input, DEFAULT_SCORING_MODEL, currentDate);

        expect(result.deadlineExpired).toBe(false);
        expect(result.score).toBeGreaterThan(0.0);
      });
    });
  });
});
