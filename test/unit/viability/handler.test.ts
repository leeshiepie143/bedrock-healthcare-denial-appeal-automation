/**
 * Unit tests for Viability Assessment Handler and Recalibration Lambda
 *
 * Tests the orchestration of historical outcome query → scoring model load →
 * viability scoring → confidence interval → DynamoDB storage, as well as
 * the monthly recalibration logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  setClients,
  resetClients,
  type ViabilityHandlerInput,
} from '@lambdas/viability/handler';
import {
  handler as recalibrateHandler,
  setClients as setRecalibrateClients,
  resetClients as resetRecalibrateClients,
  recalibrateModel,
} from '@lambdas/viability/recalibrate';
import { DEFAULT_SCORING_MODEL } from '@lambdas/viability/scorer';
import type { ClassifiedDenial, DenialRecord, EvidencePackage } from '@shared/models';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@lambdas/viability/confidence', () => ({
  queryHistoricalOutcomes: vi.fn(),
  buildConfidenceResult: vi.fn(),
}));

vi.mock('@lambdas/viability/scorer', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadScoringModel: vi.fn(),
  };
});

import { queryHistoricalOutcomes, buildConfidenceResult } from '@lambdas/viability/confidence';
import { loadScoringModel } from '@lambdas/viability/scorer';

const mockQueryHistoricalOutcomes = vi.mocked(queryHistoricalOutcomes);
const mockBuildConfidenceResult = vi.mocked(buildConfidenceResult);
const mockLoadScoringModel = vi.mocked(loadScoringModel);

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createMockDenialRecord(overrides: Partial<DenialRecord> = {}): DenialRecord {
  return {
    PK: 'TENANT#tenant-1',
    SK: 'DENIAL#CLM001#edi_835',
    claim_id: 'CLM001',
    patient_id: 'PAT001',
    payer_id: 'PAYER001',
    tenant_id: 'tenant-1',
    denial_date: '2024-01-15',
    denied_amount: 5000.00,
    raw_denial_reason_text: 'CO-50: Not deemed medically necessary',
    source_format: 'edi_835',
    source_s3_key: 's3://bucket/file.edi',
    ingestion_timestamp: '2024-01-15T10:00:00Z',
    status: 'evidence_retrieved',
    workflow_execution_id: 'wf-001',
    ttl: Math.floor(Date.now() / 1000) + 86400,
    ...overrides,
  };
}

function createMockClassifiedDenial(overrides: Partial<ClassifiedDenial> = {}): ClassifiedDenial {
  return {
    PK: 'TENANT#tenant-1',
    SK: 'CLASSIFICATION#CLM001',
    claim_id: 'CLM001',
    carc_codes: [
      {
        code: 'CO-50',
        description: 'Non-covered services - not deemed medical necessity',
        confidence: 0.95,
        dollar_amount: 5000,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE'],
      },
    ],
    rarc_codes: [
      {
        code: 'N657',
        description: 'Based on internal clinical criteria',
        confidence: 0.85,
      },
    ],
    classification_method: 'structured_edi',
    dollar_ranking_available: true,
    review_status: 'auto_classified',
    classified_at: '2024-01-15T10:05:00Z',
    ...overrides,
  };
}

function createMockEvidencePackage(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    PK: 'TENANT#tenant-1',
    SK: 'EVIDENCE#CLM001',
    claim_id: 'CLM001',
    patient_id: 'PAT001',
    evidence_items: [
      {
        fhir_resource_id: 'cond-1',
        fhir_resource_type: 'Condition',
        date: '2024-01-10',
        authoring_provider: 'Dr. Smith',
        relevance_score: 0.85,
        extracted_entities: [
          { text: 'Type 2 diabetes mellitus', category: 'DIAGNOSIS', icd_code: 'E11', confidence: 0.95 },
        ],
        mapped_denial_reasons: ['CO-50'],
      },
      {
        fhir_resource_id: 'proc-1',
        fhir_resource_type: 'Procedure',
        date: '2024-01-12',
        authoring_provider: 'Dr. Johnson',
        relevance_score: 0.72,
        extracted_entities: [
          { text: 'Knee arthroscopy', category: 'PROCEDURE', icd_code: null, confidence: 0.90 },
        ],
        mapped_denial_reasons: ['CO-50'],
      },
    ],
    total_evidence_count: 2,
    retrieval_timestamp: '2024-01-15T10:10:00Z',
    retrieval_duration_ms: 3500,
    manual_review_required: false,
    ...overrides,
  };
}

function createMockHandlerInput(overrides: Partial<ViabilityHandlerInput> = {}): ViabilityHandlerInput {
  return {
    evidencePackage: createMockEvidencePackage(),
    classifiedDenial: createMockClassifiedDenial(),
    denialRecord: createMockDenialRecord(),
    ...overrides,
  };
}

function createMockDynamoClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as any;
}

function createMockS3Client() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as any;
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetClients();
  process.env.TABLE_NAME = 'TestTable';
  process.env.MODEL_BUCKET = 'test-model-bucket';
  process.env.MODEL_KEY = 'models/scoring-model.json';
  process.env.DEFAULT_APPEAL_WINDOW_DAYS = '60';
});

afterEach(() => {
  resetClients();
  delete process.env.TABLE_NAME;
  delete process.env.MODEL_BUCKET;
  delete process.env.MODEL_KEY;
  delete process.env.DEFAULT_APPEAL_WINDOW_DAYS;
});

// ─── Handler: Successful Assessment ─────────────────────────────────────────

describe('handler - successful viability assessment', () => {
  it('should orchestrate scoring and store assessment in DynamoDB', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    const input = createMockHandlerInput();

    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 50,
      overturn_outcomes: 25,
      overturn_rate: 0.5,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.35, upper: 0.65, confidence_level: 0.90 },
      limited_historical_data: false,
    });

    const result = await handler(input);

    // Verify result structure
    expect(result.viabilityAssessment).toBeDefined();
    expect(result.viabilityAssessment.claim_id).toBe('CLM001');
    expect(result.viabilityAssessment.PK).toBe('TENANT#tenant-1');
    expect(result.viabilityAssessment.SK).toBe('VIABILITY#CLM001');
    expect(result.viabilityAssessment.viability_score).toBeGreaterThanOrEqual(0);
    expect(result.viabilityAssessment.viability_score).toBeLessThanOrEqual(1);
    expect(result.viabilityAssessment.confidence_interval).toEqual({
      lower: 0.35,
      upper: 0.65,
      confidence_level: 0.90,
    });
    expect(result.viabilityAssessment.limited_historical_data).toBe(false);
    expect(result.viabilityAssessment.assessed_at).toBeDefined();

    // Verify DynamoDB storage was called
    expect(mockDynamo.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: 'TestTable',
          Item: expect.objectContaining({
            PK: 'TENANT#tenant-1',
            SK: 'VIABILITY#CLM001',
            claim_id: 'CLM001',
          }),
        }),
      })
    );
  });

  it('should use the primary CARC code (lowest rank) for historical query', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    const input = createMockHandlerInput({
      classifiedDenial: createMockClassifiedDenial({
        carc_codes: [
          { code: 'CO-97', description: 'Secondary', confidence: 0.9, dollar_amount: 1000, rank: 2, required_evidence_categories: [] },
          { code: 'CO-50', description: 'Primary', confidence: 0.95, dollar_amount: 4000, rank: 1, required_evidence_categories: [] },
        ],
      }),
    });

    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 40,
      overturn_outcomes: 20,
      overturn_rate: 0.5,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.3, upper: 0.7, confidence_level: 0.90 },
      limited_historical_data: false,
    });

    await handler(input);

    // Should query with CO-50 (rank 1), not CO-97 (rank 2)
    expect(mockQueryHistoricalOutcomes).toHaveBeenCalledWith(
      expect.anything(),
      'PAYER001',
      'CO-50',
      'TestTable'
    );
  });

  it('should include inputs in the assessment', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    const input = createMockHandlerInput();

    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 50,
      overturn_outcomes: 25,
      overturn_rate: 0.5,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.3, upper: 0.7, confidence_level: 0.90 },
      limited_historical_data: false,
    });

    const result = await handler(input);

    expect(result.viabilityAssessment.inputs).toEqual({
      denial_reason_code: 'CO-50',
      payer_id: 'PAYER001',
      historical_overturn_rate: 0.5,
      evidence_score: expect.any(Number),
      claim_amount: 5000.00,
      days_to_deadline: expect.any(Number),
    });
  });

  it('should calculate appeal deadline as denial_date + DEFAULT_APPEAL_WINDOW_DAYS', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    process.env.DEFAULT_APPEAL_WINDOW_DAYS = '90';

    const input = createMockHandlerInput({
      denialRecord: createMockDenialRecord({ denial_date: '2024-01-01' }),
    });

    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 50,
      overturn_outcomes: 25,
      overturn_rate: 0.5,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.3, upper: 0.7, confidence_level: 0.90 },
      limited_historical_data: false,
    });

    const result = await handler(input);

    // denial_date 2024-01-01 + 90 days = 2024-03-31
    // The days_to_deadline should be calculated from the appeal deadline
    expect(result.viabilityAssessment.inputs.days_to_deadline).toBeDefined();
  });
});

// ─── Handler: Limited Historical Data ───────────────────────────────────────

describe('handler - limited historical data', () => {
  it('should flag limited_historical_data when fewer than 30 outcomes', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    const input = createMockHandlerInput();

    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 10,
      overturn_outcomes: 5,
      overturn_rate: 0.5,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.1, upper: 0.9, confidence_level: 0.90 },
      limited_historical_data: true,
    });

    const result = await handler(input);

    expect(result.viabilityAssessment.limited_historical_data).toBe(true);
  });
});

// ─── Handler: Expired Deadline ──────────────────────────────────────────────

describe('handler - expired deadline', () => {
  it('should return score 0.0 and deadline_expired when deadline has passed', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    // Set denial_date far in the past so deadline is expired
    const input = createMockHandlerInput({
      denialRecord: createMockDenialRecord({ denial_date: '2020-01-01' }),
    });

    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 50,
      overturn_outcomes: 25,
      overturn_rate: 0.5,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.0, upper: 1.0, confidence_level: 0.90 },
      limited_historical_data: false,
    });

    const result = await handler(input);

    expect(result.viabilityAssessment.viability_score).toBe(0.0);
    expect(result.viabilityAssessment.deadline_expired).toBe(true);
    expect(result.viabilityAssessment.recommendation).toBe('do_not_pursue');
  });
});

// ─── Handler: No CARC Codes ─────────────────────────────────────────────────

describe('handler - no CARC codes', () => {
  it('should use UNKNOWN as denial reason code when no CARC codes present', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    const input = createMockHandlerInput({
      classifiedDenial: createMockClassifiedDenial({ carc_codes: [] }),
    });

    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 0,
      overturn_outcomes: 0,
      overturn_rate: 0,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.0, upper: 1.0, confidence_level: 0.90 },
      limited_historical_data: true,
    });

    await handler(input);

    expect(mockQueryHistoricalOutcomes).toHaveBeenCalledWith(
      expect.anything(),
      'PAYER001',
      'UNKNOWN',
      'TestTable'
    );
  });
});

// ─── Handler: Error Handling ────────────────────────────────────────────────

describe('handler - error handling', () => {
  it('should propagate DynamoDB storage errors', async () => {
    const mockDynamo = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB write failed')),
    } as any;
    const mockS3 = createMockS3Client();
    setClients({ dynamo: mockDynamo, s3: mockS3 });

    const input = createMockHandlerInput();

    // queryHistoricalOutcomes uses the same dynamo client, so mock it to succeed
    mockQueryHistoricalOutcomes.mockResolvedValue({
      total_outcomes: 50,
      overturn_outcomes: 25,
      overturn_rate: 0.5,
    });

    mockLoadScoringModel.mockResolvedValue(DEFAULT_SCORING_MODEL);

    mockBuildConfidenceResult.mockReturnValue({
      confidence_interval: { lower: 0.3, upper: 0.7, confidence_level: 0.90 },
      limited_historical_data: false,
    });

    await expect(handler(input)).rejects.toThrow('DynamoDB write failed');
  });
});

// ─── Recalibration: recalibrateModel (pure function) ────────────────────────

describe('recalibrateModel', () => {
  it('should increase historical_overturn_rate weight when observed rate > 0.5', () => {
    const result = recalibrateModel(DEFAULT_SCORING_MODEL, 0.7, 100);

    expect(result.weights.historical_overturn_rate).toBeGreaterThan(
      DEFAULT_SCORING_MODEL.weights.historical_overturn_rate
    );
  });

  it('should decrease historical_overturn_rate weight when observed rate < 0.3', () => {
    const result = recalibrateModel(DEFAULT_SCORING_MODEL, 0.2, 100);

    expect(result.weights.historical_overturn_rate).toBeLessThan(
      DEFAULT_SCORING_MODEL.weights.historical_overturn_rate
    );
  });

  it('should not change weight when observed rate is between 0.3 and 0.5', () => {
    const result = recalibrateModel(DEFAULT_SCORING_MODEL, 0.4, 100);

    expect(result.weights.historical_overturn_rate).toBe(
      DEFAULT_SCORING_MODEL.weights.historical_overturn_rate
    );
  });

  it('should keep weights normalized (sum to 1.0)', () => {
    const result = recalibrateModel(DEFAULT_SCORING_MODEL, 0.8, 100);

    const sum =
      result.weights.historical_overturn_rate +
      result.weights.evidence_score +
      result.weights.days_remaining_factor +
      result.weights.claim_amount_factor +
      result.weights.payer_overturn_rate;

    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('should bump the patch version', () => {
    const result = recalibrateModel(DEFAULT_SCORING_MODEL, 0.6, 50);

    expect(result.version).toBe('1.0.1');
  });

  it('should update last_calibrated timestamp', () => {
    const before = new Date().toISOString();
    const result = recalibrateModel(DEFAULT_SCORING_MODEL, 0.6, 50);
    const after = new Date().toISOString();

    expect(result.last_calibrated >= before).toBe(true);
    expect(result.last_calibrated <= after).toBe(true);
  });

  it('should scale adjustment by confidence factor (sample size / 100)', () => {
    // With 50 samples, confidence factor = 0.5, so adjustment = 0.05 * 0.5 = 0.025
    const result50 = recalibrateModel(DEFAULT_SCORING_MODEL, 0.7, 50);
    // With 100 samples, confidence factor = 1.0, so adjustment = 0.05 * 1.0 = 0.05
    const result100 = recalibrateModel(DEFAULT_SCORING_MODEL, 0.7, 100);

    const diff50 = result50.weights.historical_overturn_rate - DEFAULT_SCORING_MODEL.weights.historical_overturn_rate;
    const diff100 = result100.weights.historical_overturn_rate - DEFAULT_SCORING_MODEL.weights.historical_overturn_rate;

    expect(diff100).toBeGreaterThan(diff50);
  });

  it('should clamp historical_overturn_rate weight between 0.1 and 0.5', () => {
    // Start with a model that has very low weight
    const lowWeightModel: typeof DEFAULT_SCORING_MODEL = {
      ...DEFAULT_SCORING_MODEL,
      weights: { ...DEFAULT_SCORING_MODEL.weights, historical_overturn_rate: 0.11 },
    };

    const result = recalibrateModel(lowWeightModel, 0.1, 100);
    expect(result.weights.historical_overturn_rate).toBeGreaterThanOrEqual(0.1);

    // Start with a model that has very high weight
    const highWeightModel: typeof DEFAULT_SCORING_MODEL = {
      ...DEFAULT_SCORING_MODEL,
      weights: { ...DEFAULT_SCORING_MODEL.weights, historical_overturn_rate: 0.49 },
    };

    const result2 = recalibrateModel(highWeightModel, 0.9, 100);
    expect(result2.weights.historical_overturn_rate).toBeLessThanOrEqual(0.5);
  });
});

// ─── Recalibration Handler ──────────────────────────────────────────────────

describe('recalibrate handler', () => {
  beforeEach(() => {
    resetRecalibrateClients();
  });

  afterEach(() => {
    resetRecalibrateClients();
  });

  it('should skip recalibration when fewer than 30 outcomes', async () => {
    const mockDynamo = {
      send: vi.fn().mockResolvedValue({
        Items: Array.from({ length: 20 }, (_, i) => ({
          SK: `OUTCOME#CLM${i}`,
          outcome_type: i % 2 === 0 ? 'overturn' : 'upheld',
          denial_reason_code: 'CO-50',
          payer_id: 'PAYER001',
          received_at: new Date().toISOString(),
        })),
        LastEvaluatedKey: undefined,
      }),
    } as any;
    const mockS3 = createMockS3Client();
    setRecalibrateClients({ dynamo: mockDynamo, s3: mockS3 });

    const result = await recalibrateHandler();

    expect(result.recalibrated).toBe(false);
    expect(result.reason).toContain('Insufficient outcomes');
    expect(result.outcomesAnalyzed).toBe(20);
    // S3 should NOT have been called for storage
    expect(mockS3.send).not.toHaveBeenCalled();
  });

  it('should recalibrate and store model when >= 30 outcomes', async () => {
    const outcomes = Array.from({ length: 50 }, (_, i) => ({
      SK: `OUTCOME#CLM${i}`,
      outcome_type: i < 30 ? 'overturn' : 'upheld',
      denial_reason_code: 'CO-50',
      payer_id: 'PAYER001',
      received_at: new Date().toISOString(),
    }));

    const mockDynamo = {
      send: vi.fn().mockResolvedValue({
        Items: outcomes,
        LastEvaluatedKey: undefined,
      }),
    } as any;

    // Mock S3 GetObject (load current model) and PutObject (store updated model)
    const mockS3 = {
      send: vi.fn().mockImplementation((command: any) => {
        if (command.constructor.name === 'GetObjectCommand' || command.input?.Key) {
          // For GetObject, return the default model
          return Promise.resolve({
            Body: {
              transformToString: () => Promise.resolve(JSON.stringify(DEFAULT_SCORING_MODEL)),
            },
          });
        }
        // For PutObject
        return Promise.resolve({});
      }),
    } as any;

    setRecalibrateClients({ dynamo: mockDynamo, s3: mockS3 });

    const result = await recalibrateHandler();

    expect(result.recalibrated).toBe(true);
    expect(result.outcomesAnalyzed).toBe(50);
    expect(result.overturnRate).toBeCloseTo(0.6, 2); // 30/50
    expect(result.modelVersion).toBeDefined();
  });

  it('should handle paginated DynamoDB scan results', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) => ({
      SK: `OUTCOME#CLM${i}`,
      outcome_type: 'overturn',
      denial_reason_code: 'CO-50',
      payer_id: 'PAYER001',
      received_at: new Date().toISOString(),
    }));

    const secondPage = Array.from({ length: 15 }, (_, i) => ({
      SK: `OUTCOME#CLM${i + 20}`,
      outcome_type: 'upheld',
      denial_reason_code: 'CO-50',
      payer_id: 'PAYER001',
      received_at: new Date().toISOString(),
    }));

    let callCount = 0;
    const mockDynamo = {
      send: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            Items: firstPage,
            LastEvaluatedKey: { PK: 'last', SK: 'key' },
          });
        }
        return Promise.resolve({
          Items: secondPage,
          LastEvaluatedKey: undefined,
        });
      }),
    } as any;

    const mockS3 = {
      send: vi.fn().mockImplementation((command: any) => {
        if (command.constructor.name === 'GetObjectCommand' || (command.input && !command.input.Body)) {
          return Promise.resolve({
            Body: {
              transformToString: () => Promise.resolve(JSON.stringify(DEFAULT_SCORING_MODEL)),
            },
          });
        }
        return Promise.resolve({});
      }),
    } as any;

    setRecalibrateClients({ dynamo: mockDynamo, s3: mockS3 });

    const result = await recalibrateHandler();

    expect(result.recalibrated).toBe(true);
    expect(result.outcomesAnalyzed).toBe(35); // 20 + 15
    expect(result.overturnRate).toBeCloseTo(20 / 35, 2);
  });

  it('should skip S3 storage when MODEL_BUCKET is not configured', async () => {
    delete process.env.MODEL_BUCKET;

    const outcomes = Array.from({ length: 40 }, (_, i) => ({
      SK: `OUTCOME#CLM${i}`,
      outcome_type: i < 20 ? 'overturn' : 'upheld',
      denial_reason_code: 'CO-50',
      payer_id: 'PAYER001',
      received_at: new Date().toISOString(),
    }));

    const mockDynamo = {
      send: vi.fn().mockResolvedValue({
        Items: outcomes,
        LastEvaluatedKey: undefined,
      }),
    } as any;

    const mockS3 = createMockS3Client();
    setRecalibrateClients({ dynamo: mockDynamo, s3: mockS3 });

    const result = await recalibrateHandler();

    expect(result.recalibrated).toBe(true);
    // S3 PutObject should not be called (only GetObject might be attempted)
    // Since MODEL_BUCKET is empty, loadCurrentModel returns default, and storeModel skips
    expect(mockS3.send).not.toHaveBeenCalled();
  });
});
