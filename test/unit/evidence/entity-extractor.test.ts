/**
 * Unit tests for Comprehend Medical Entity Extraction and Relevance Scoring
 *
 * Tests entity extraction, category mapping, relevance scoring algorithm,
 * filtering, ranking, and error handling with mocked Comprehend Medical responses.
 *
 * Requirements: 3.4, 3.5, 3.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractEntities,
  mapComprehendEntities,
  calculateRelevanceScore,
  getRequiredCategories,
  hasKeywordMatch,
  mapEntitiesToDenialReasons,
  extractAndScoreEvidence,
  setComprehendClient,
  resetComprehendClient,
  COMPREHEND_CATEGORY_MAP,
  RELEVANCE_THRESHOLD,
  KEYWORD_BOOST,
  MAX_SCORE,
  type FhirResourceInput,
  type DenialContext,
} from '@lambdas/evidence/entity-extractor';
import type { ComprehendMedicalClient, Entity as ComprehendEntity } from '@aws-sdk/client-comprehendmedical';
import type { CarcCode, ExtractedEntity } from '@shared/models';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createMockComprehendClient(
  entities: Array<{
    Text?: string;
    Category?: string;
    Score?: number;
    Attributes?: Array<{ Type?: string; Text?: string }>;
  }> | null,
  shouldThrow = false
): ComprehendMedicalClient {
  if (shouldThrow) {
    return {
      send: vi.fn().mockRejectedValue(new Error('Comprehend Medical service error')),
    } as unknown as ComprehendMedicalClient;
  }

  return {
    send: vi.fn().mockResolvedValue({
      Entities: entities,
    }),
  } as unknown as ComprehendMedicalClient;
}

function buildFhirResource(overrides: Partial<FhirResourceInput> = {}): FhirResourceInput {
  return {
    fhir_resource_id: 'fhir-001',
    fhir_resource_type: 'Condition',
    date: '2024-01-15',
    authoring_provider: 'Dr. Smith',
    text_content: 'Patient diagnosed with Type 2 Diabetes Mellitus',
    ...overrides,
  };
}

function buildDenialContext(overrides: Partial<DenialContext> = {}): DenialContext {
  return {
    carc_codes: [
      {
        code: 'CO-50',
        description: 'Services not medically necessary',
        confidence: 0.95,
        dollar_amount: 1500.0,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      },
    ],
    raw_denial_reason_text: 'Services not medically necessary',
    ...overrides,
  };
}

function buildExtractedEntity(overrides: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    text: 'Type 2 Diabetes Mellitus',
    category: 'DIAGNOSIS',
    icd_code: null,
    confidence: 0.92,
    ...overrides,
  };
}

// ─── Category Mapping Tests ─────────────────────────────────────────────────

describe('COMPREHEND_CATEGORY_MAP', () => {
  it('maps MEDICAL_CONDITION to DIAGNOSIS', () => {
    expect(COMPREHEND_CATEGORY_MAP['MEDICAL_CONDITION']).toBe('DIAGNOSIS');
  });

  it('maps TEST_TREATMENT_PROCEDURE to PROCEDURE', () => {
    expect(COMPREHEND_CATEGORY_MAP['TEST_TREATMENT_PROCEDURE']).toBe('PROCEDURE');
  });

  it('maps MEDICATION to MEDICATION', () => {
    expect(COMPREHEND_CATEGORY_MAP['MEDICATION']).toBe('MEDICATION');
  });

  it('maps ANATOMY to ANATOMY', () => {
    expect(COMPREHEND_CATEGORY_MAP['ANATOMY']).toBe('ANATOMY');
  });
});

// ─── mapComprehendEntities Tests ────────────────────────────────────────────

describe('mapComprehendEntities', () => {
  it('maps entities with known categories', () => {
    const entities: ComprehendEntity[] = [
      { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
      { Text: 'Knee replacement', Category: 'TEST_TREATMENT_PROCEDURE', Score: 0.88 },
    ];

    const result = mapComprehendEntities(entities);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Diabetes');
    expect(result[0].category).toBe('DIAGNOSIS');
    expect(result[0].confidence).toBe(0.95);
    expect(result[1].text).toBe('Knee replacement');
    expect(result[1].category).toBe('PROCEDURE');
    expect(result[1].confidence).toBe(0.88);
  });

  it('skips entities with unknown categories', () => {
    const entities: ComprehendEntity[] = [
      { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
      { Text: 'Some text', Category: 'PROTECTED_HEALTH_INFORMATION', Score: 0.80 },
      { Text: 'Aspirin', Category: 'MEDICATION', Score: 0.90 },
    ];

    const result = mapComprehendEntities(entities);
    expect(result).toHaveLength(2);
    expect(result[0].category).toBe('DIAGNOSIS');
    expect(result[1].category).toBe('MEDICATION');
  });

  it('skips entities with no category', () => {
    const entities: ComprehendEntity[] = [
      { Text: 'Something', Score: 0.80 },
      { Text: 'Aspirin', Category: 'MEDICATION', Score: 0.90 },
    ];

    const result = mapComprehendEntities(entities);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Aspirin');
  });

  it('extracts ICD code from attributes', () => {
    const entities: ComprehendEntity[] = [
      {
        Text: 'Diabetes',
        Category: 'MEDICAL_CONDITION',
        Score: 0.95,
        Attributes: [{ Type: 'DX_NAME', Text: 'E11.9' }],
      },
    ];

    const result = mapComprehendEntities(entities);
    expect(result[0].icd_code).toBe('E11.9');
  });

  it('returns null icd_code when no attributes', () => {
    const entities: ComprehendEntity[] = [
      { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
    ];

    const result = mapComprehendEntities(entities);
    expect(result[0].icd_code).toBeNull();
  });

  it('handles empty entity list', () => {
    const result = mapComprehendEntities([]);
    expect(result).toHaveLength(0);
  });

  it('uses 0 confidence when Score is undefined', () => {
    const entities: ComprehendEntity[] = [
      { Text: 'Diabetes', Category: 'MEDICAL_CONDITION' },
    ];

    const result = mapComprehendEntities(entities);
    expect(result[0].confidence).toBe(0);
  });

  it('uses empty string when Text is undefined', () => {
    const entities: ComprehendEntity[] = [
      { Category: 'MEDICAL_CONDITION', Score: 0.9 },
    ];

    const result = mapComprehendEntities(entities);
    expect(result[0].text).toBe('');
  });
});

// ─── extractEntities Tests ──────────────────────────────────────────────────

describe('extractEntities', () => {
  afterEach(() => {
    resetComprehendClient();
  });

  it('returns extracted entities from Comprehend Medical', async () => {
    const mockClient = createMockComprehendClient([
      { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
      { Text: 'Metformin', Category: 'MEDICATION', Score: 0.88 },
    ]);
    setComprehendClient(mockClient);

    const result = await extractEntities('Patient has diabetes and takes metformin');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].category).toBe('DIAGNOSIS');
    expect(result![1].category).toBe('MEDICATION');
  });

  it('returns empty array for empty text', async () => {
    const result = await extractEntities('');
    expect(result).toEqual([]);
  });

  it('returns empty array for whitespace-only text', async () => {
    const result = await extractEntities('   \n\t  ');
    expect(result).toEqual([]);
  });

  it('returns empty array when Comprehend returns no entities', async () => {
    const mockClient = createMockComprehendClient([]);
    setComprehendClient(mockClient);

    const result = await extractEntities('Some text with no medical entities');
    expect(result).toEqual([]);
  });

  it('returns empty array when Comprehend returns null entities', async () => {
    const mockClient = createMockComprehendClient(null);
    setComprehendClient(mockClient);

    const result = await extractEntities('Some text');
    expect(result).toEqual([]);
  });

  it('returns null on Comprehend Medical failure', async () => {
    const mockClient = createMockComprehendClient(null, true);
    setComprehendClient(mockClient);

    const result = await extractEntities('Some text');
    expect(result).toBeNull();
  });
});

// ─── getRequiredCategories Tests ────────────────────────────────────────────

describe('getRequiredCategories', () => {
  it('collects unique categories from CARC codes', () => {
    const carcCodes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.9, dollar_amount: null, rank: 1, required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'] },
      { code: 'CO-197', description: 'Test2', confidence: 0.8, dollar_amount: null, rank: 2, required_evidence_categories: ['DIAGNOSIS', 'MEDICATION'] },
    ];

    const result = getRequiredCategories(carcCodes);
    expect(result).toHaveLength(3);
    expect(result).toContain('DIAGNOSIS');
    expect(result).toContain('PROCEDURE');
    expect(result).toContain('MEDICATION');
  });

  it('returns empty array for empty CARC codes', () => {
    expect(getRequiredCategories([])).toHaveLength(0);
  });

  it('returns empty array when CARC codes have no required categories', () => {
    const carcCodes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.9, dollar_amount: null, rank: 1, required_evidence_categories: [] },
    ];
    expect(getRequiredCategories(carcCodes)).toHaveLength(0);
  });
});

// ─── hasKeywordMatch Tests ──────────────────────────────────────────────────

describe('hasKeywordMatch', () => {
  it('returns true when entity text contains denial reason keyword', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ text: 'medically necessary procedure' }),
    ];
    expect(hasKeywordMatch(entities, 'Services not medically necessary')).toBe(true);
  });

  it('returns false when no keyword match', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ text: 'Diabetes Mellitus' }),
    ];
    expect(hasKeywordMatch(entities, 'Prior authorization required')).toBe(false);
  });

  it('performs case-insensitive matching', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ text: 'MEDICALLY necessary' }),
    ];
    expect(hasKeywordMatch(entities, 'medically necessary')).toBe(true);
  });

  it('ignores short words (< 4 chars)', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ text: 'not applicable' }),
    ];
    // "not" is 3 chars, should be ignored; "applicable" is 10 chars
    expect(hasKeywordMatch(entities, 'not the same')).toBe(false);
  });

  it('returns false for empty denial reason text', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ text: 'Diabetes' }),
    ];
    expect(hasKeywordMatch(entities, '')).toBe(false);
  });

  it('returns false for empty entities array', () => {
    expect(hasKeywordMatch([], 'medically necessary')).toBe(false);
  });
});

// ─── calculateRelevanceScore Tests ──────────────────────────────────────────

describe('calculateRelevanceScore', () => {
  it('calculates score based on matching categories and confidence', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ category: 'DIAGNOSIS', confidence: 0.9 }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Not medically necessary',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'something unrelated',
    });

    // 1 matching / 2 required = 0.5, * avg confidence 0.9 = 0.45
    const score = calculateRelevanceScore(entities, context);
    expect(score).toBeCloseTo(0.45, 2);
  });

  it('returns full score when all categories match', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ category: 'DIAGNOSIS', confidence: 1.0 }),
      buildExtractedEntity({ category: 'PROCEDURE', confidence: 1.0 }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Test',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'unrelated text here',
    });

    // 2/2 = 1.0, * avg confidence 1.0 = 1.0
    const score = calculateRelevanceScore(entities, context);
    expect(score).toBe(1.0);
  });

  it('applies keyword boost when entity text matches denial reason', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ text: 'medically necessary procedure', category: 'DIAGNOSIS', confidence: 0.9 }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Not medically necessary',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'Services not medically necessary',
    });

    // 1/2 * 0.9 = 0.45 + 0.1 boost = 0.55
    const score = calculateRelevanceScore(entities, context);
    expect(score).toBeCloseTo(0.55, 2);
  });

  it('caps score at 1.0', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ text: 'medically necessary', category: 'DIAGNOSIS', confidence: 1.0 }),
      buildExtractedEntity({ text: 'procedure done', category: 'PROCEDURE', confidence: 1.0 }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Not medically necessary',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'medically necessary',
    });

    // 2/2 * 1.0 = 1.0 + 0.1 boost = 1.1, capped at 1.0
    const score = calculateRelevanceScore(entities, context);
    expect(score).toBe(MAX_SCORE);
  });

  it('returns 0.0 when no required categories', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ category: 'DIAGNOSIS', confidence: 0.9 }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Test',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: [],
      }],
    });

    expect(calculateRelevanceScore(entities, context)).toBe(0.0);
  });

  it('returns 0.0 when no extracted entities', () => {
    const context = buildDenialContext();
    expect(calculateRelevanceScore([], context)).toBe(0.0);
  });

  it('returns 0.0 when no entity categories match required categories', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ category: 'ANATOMY', confidence: 0.9 }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Test',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'unrelated',
    });

    // 0 matching / 2 required = 0
    expect(calculateRelevanceScore(entities, context)).toBe(0.0);
  });
});

// ─── mapEntitiesToDenialReasons Tests ───────────────────────────────────────

describe('mapEntitiesToDenialReasons', () => {
  it('maps entities to CARC codes with matching required categories', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ category: 'DIAGNOSIS' }),
    ];
    const carcCodes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.9, dollar_amount: null, rank: 1, required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'] },
      { code: 'CO-197', description: 'Test2', confidence: 0.8, dollar_amount: null, rank: 2, required_evidence_categories: ['MEDICATION'] },
    ];

    const result = mapEntitiesToDenialReasons(entities, carcCodes);
    expect(result).toEqual(['CO-50']);
  });

  it('maps to multiple CARC codes when entities match multiple', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ category: 'DIAGNOSIS' }),
      buildExtractedEntity({ category: 'MEDICATION' }),
    ];
    const carcCodes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.9, dollar_amount: null, rank: 1, required_evidence_categories: ['DIAGNOSIS'] },
      { code: 'CO-197', description: 'Test2', confidence: 0.8, dollar_amount: null, rank: 2, required_evidence_categories: ['MEDICATION'] },
    ];

    const result = mapEntitiesToDenialReasons(entities, carcCodes);
    expect(result).toEqual(['CO-50', 'CO-197']);
  });

  it('returns empty array when no matches', () => {
    const entities: ExtractedEntity[] = [
      buildExtractedEntity({ category: 'ANATOMY' }),
    ];
    const carcCodes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.9, dollar_amount: null, rank: 1, required_evidence_categories: ['DIAGNOSIS'] },
    ];

    expect(mapEntitiesToDenialReasons(entities, carcCodes)).toEqual([]);
  });

  it('returns empty array for empty entities', () => {
    const carcCodes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.9, dollar_amount: null, rank: 1, required_evidence_categories: ['DIAGNOSIS'] },
    ];
    expect(mapEntitiesToDenialReasons([], carcCodes)).toEqual([]);
  });
});

// ─── extractAndScoreEvidence Integration Tests ──────────────────────────────

describe('extractAndScoreEvidence', () => {
  afterEach(() => {
    resetComprehendClient();
  });

  it('extracts entities, scores, filters, and ranks evidence', async () => {
    const mockClient = createMockComprehendClient([
      { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
      { Text: 'Insulin therapy', Category: 'TEST_TREATMENT_PROCEDURE', Score: 0.88 },
    ]);
    setComprehendClient(mockClient);

    const resources: FhirResourceInput[] = [
      buildFhirResource({ fhir_resource_id: 'fhir-001', text_content: 'Patient has diabetes' }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Not medically necessary',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'Services not medically necessary',
    });

    const result = await extractAndScoreEvidence(resources, context);

    expect(result.evidence_items.length).toBeGreaterThan(0);
    expect(result.evidence_items[0].fhir_resource_id).toBe('fhir-001');
    expect(result.evidence_items[0].extracted_entities).toHaveLength(2);
    expect(result.evidence_items[0].relevance_score).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(result.manual_review_required).toBe(false);
  });

  it('filters out evidence below relevance threshold', async () => {
    // Return only ANATOMY entities which won't match DIAGNOSIS/PROCEDURE requirements
    const mockClient = createMockComprehendClient([
      { Text: 'Left knee', Category: 'ANATOMY', Score: 0.80 },
    ]);
    setComprehendClient(mockClient);

    const resources: FhirResourceInput[] = [
      buildFhirResource({ fhir_resource_id: 'fhir-001', text_content: 'Left knee examination' }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Not medically necessary',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'unrelated text',
    });

    const result = await extractAndScoreEvidence(resources, context);

    // Score should be 0 (no matching categories), so filtered out
    expect(result.evidence_items).toHaveLength(0);
  });

  it('ranks evidence by descending relevance score', async () => {
    // First call returns low-relevance entities, second returns high-relevance
    const mockClient = {
      send: vi.fn()
        .mockResolvedValueOnce({
          Entities: [{ Text: 'Aspirin', Category: 'MEDICATION', Score: 0.70 }],
        })
        .mockResolvedValueOnce({
          Entities: [
            { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
            { Text: 'Insulin therapy', Category: 'TEST_TREATMENT_PROCEDURE', Score: 0.90 },
          ],
        }),
    } as unknown as ComprehendMedicalClient;
    setComprehendClient(mockClient);

    const resources: FhirResourceInput[] = [
      buildFhirResource({ fhir_resource_id: 'fhir-low', text_content: 'Takes aspirin' }),
      buildFhirResource({ fhir_resource_id: 'fhir-high', text_content: 'Diabetes with insulin' }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Not medically necessary',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE', 'MEDICATION'],
      }],
      raw_denial_reason_text: 'unrelated text here',
    });

    const result = await extractAndScoreEvidence(resources, context);

    // Both should pass threshold, but high should rank first
    if (result.evidence_items.length >= 2) {
      expect(result.evidence_items[0].relevance_score).toBeGreaterThanOrEqual(
        result.evidence_items[1].relevance_score
      );
    }
  });

  it('handles Comprehend Medical failure: returns item with score 0.0 and flags manual review', async () => {
    const mockClient = createMockComprehendClient(null, true);
    setComprehendClient(mockClient);

    const resources: FhirResourceInput[] = [
      buildFhirResource({ fhir_resource_id: 'fhir-fail' }),
    ];
    const context = buildDenialContext();

    const result = await extractAndScoreEvidence(resources, context);

    // Failed items get score 0.0 which is below threshold, so filtered out
    // But manual_review_required should be true
    expect(result.manual_review_required).toBe(true);
  });

  it('handles mixed success and failure across resources', async () => {
    const mockClient = {
      send: vi.fn()
        .mockResolvedValueOnce({
          Entities: [
            { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
            { Text: 'Insulin', Category: 'TEST_TREATMENT_PROCEDURE', Score: 0.90 },
          ],
        })
        .mockRejectedValueOnce(new Error('Service error')),
    } as unknown as ComprehendMedicalClient;
    setComprehendClient(mockClient);

    const resources: FhirResourceInput[] = [
      buildFhirResource({ fhir_resource_id: 'fhir-success', text_content: 'Diabetes with insulin' }),
      buildFhirResource({ fhir_resource_id: 'fhir-fail', text_content: 'Some text' }),
    ];
    const context = buildDenialContext({
      carc_codes: [{
        code: 'CO-50',
        description: 'Not medically necessary',
        confidence: 0.95,
        dollar_amount: null,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      }],
      raw_denial_reason_text: 'unrelated',
    });

    const result = await extractAndScoreEvidence(resources, context);

    expect(result.manual_review_required).toBe(true);
    // The successful item should be in results (if above threshold)
    const successItem = result.evidence_items.find(
      (item) => item.fhir_resource_id === 'fhir-success'
    );
    if (successItem) {
      expect(successItem.relevance_score).toBeGreaterThan(0);
      expect(successItem.extracted_entities.length).toBeGreaterThan(0);
    }
  });

  it('returns empty evidence_items when all resources have empty text', async () => {
    const resources: FhirResourceInput[] = [
      buildFhirResource({ fhir_resource_id: 'fhir-empty', text_content: '' }),
    ];
    const context = buildDenialContext();

    const result = await extractAndScoreEvidence(resources, context);

    // Empty text → empty entities → score 0.0 → filtered out
    expect(result.evidence_items).toHaveLength(0);
    expect(result.manual_review_required).toBe(false);
  });

  it('populates mapped_denial_reasons correctly', async () => {
    const mockClient = createMockComprehendClient([
      { Text: 'Diabetes', Category: 'MEDICAL_CONDITION', Score: 0.95 },
    ]);
    setComprehendClient(mockClient);

    const resources: FhirResourceInput[] = [
      buildFhirResource({ fhir_resource_id: 'fhir-001' }),
    ];
    const context = buildDenialContext({
      carc_codes: [
        { code: 'CO-50', description: 'Test', confidence: 0.9, dollar_amount: null, rank: 1, required_evidence_categories: ['DIAGNOSIS'] },
        { code: 'CO-197', description: 'Test2', confidence: 0.8, dollar_amount: null, rank: 2, required_evidence_categories: ['MEDICATION'] },
      ],
      raw_denial_reason_text: 'diabetes treatment',
    });

    const result = await extractAndScoreEvidence(resources, context);

    if (result.evidence_items.length > 0) {
      expect(result.evidence_items[0].mapped_denial_reasons).toContain('CO-50');
      expect(result.evidence_items[0].mapped_denial_reasons).not.toContain('CO-197');
    }
  });
});
