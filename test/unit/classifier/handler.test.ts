/**
 * Unit tests for Classifier Handler
 *
 * Tests routing logic, DynamoDB storage, guardrail intervention logging,
 * and error handling for the classification Step Functions task handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  setClients,
  resetClients,
  isStructuredFormat,
  isUnstructuredFormat,
} from '@lambdas/classifier/handler';
import type { ClassifierHandlerResult } from '@lambdas/classifier/handler';
import type { DenialRecord } from '@shared/models';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@lambdas/classifier/structured-classifier', () => ({
  classifyStructuredEDI: vi.fn(),
}));

vi.mock('@lambdas/classifier/nlp-classifier', () => ({
  classifyWithNlp: vi.fn(),
}));

import { classifyStructuredEDI } from '@lambdas/classifier/structured-classifier';
import { classifyWithNlp } from '@lambdas/classifier/nlp-classifier';

const mockClassifyStructuredEDI = vi.mocked(classifyStructuredEDI);
const mockClassifyWithNlp = vi.mocked(classifyWithNlp);

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
    denied_amount: 150.00,
    raw_denial_reason_text: 'CO-45: $100.00; CO-253: $50.00',
    source_format: 'edi_835',
    source_s3_key: 's3://bucket/file.edi',
    ingestion_timestamp: '2024-01-15T10:00:00Z',
    status: 'ingested',
    workflow_execution_id: 'wf-001',
    ttl: Math.floor(Date.now() / 1000) + 86400,
    ...overrides,
  };
}

function createMockDynamoClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as any;
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetClients();
  process.env.TABLE_NAME = 'TestTable';
  process.env.GUARDRAIL_ID = 'test-guardrail-id';
  process.env.GUARDRAIL_VERSION = '1';
});

afterEach(() => {
  resetClients();
  delete process.env.TABLE_NAME;
  delete process.env.GUARDRAIL_ID;
  delete process.env.GUARDRAIL_VERSION;
});

// ─── Routing Logic Tests ────────────────────────────────────────────────────

describe('isStructuredFormat', () => {
  it('should return true for edi_835', () => {
    expect(isStructuredFormat('edi_835')).toBe(true);
  });

  it('should return true for edi_277', () => {
    expect(isStructuredFormat('edi_277')).toBe(true);
  });

  it('should return false for pdf', () => {
    expect(isStructuredFormat('pdf')).toBe(false);
  });

  it('should return false for tiff', () => {
    expect(isStructuredFormat('tiff')).toBe(false);
  });

  it('should return false for png', () => {
    expect(isStructuredFormat('png')).toBe(false);
  });

  it('should return false for jpeg', () => {
    expect(isStructuredFormat('jpeg')).toBe(false);
  });
});

describe('isUnstructuredFormat', () => {
  it('should return true for pdf', () => {
    expect(isUnstructuredFormat('pdf')).toBe(true);
  });

  it('should return true for tiff', () => {
    expect(isUnstructuredFormat('tiff')).toBe(true);
  });

  it('should return true for png', () => {
    expect(isUnstructuredFormat('png')).toBe(true);
  });

  it('should return true for jpeg', () => {
    expect(isUnstructuredFormat('jpeg')).toBe(true);
  });

  it('should return false for edi_835', () => {
    expect(isUnstructuredFormat('edi_835')).toBe(false);
  });

  it('should return false for edi_277', () => {
    expect(isUnstructuredFormat('edi_277')).toBe(false);
  });
});

// ─── Handler: Structured EDI Routing ────────────────────────────────────────

describe('handler - structured EDI routing', () => {
  it('should route edi_835 to structured classifier', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'edi_835' });

    mockClassifyStructuredEDI.mockResolvedValue({
      classifiedDenial: {
        PK: 'TENANT#tenant-1',
        SK: 'CLASSIFICATION#CLM001',
        claim_id: 'CLM001',
        carc_codes: [
          {
            code: '45',
            description: 'Charge exceeds fee schedule',
            confidence: 1.0,
            dollar_amount: 100,
            rank: 1,
            required_evidence_categories: ['medical_necessity'],
          },
        ],
        rarc_codes: [],
        classification_method: 'structured_edi',
        dollar_ranking_available: true,
        review_status: 'auto_classified',
        classified_at: '2024-01-15T10:00:00Z',
      },
      unmappedCodes: [],
    });

    const result = await handler(denialRecord);

    expect(mockClassifyStructuredEDI).toHaveBeenCalledWith(
      denialRecord,
      mockDynamo,
      'TestTable'
    );
    expect(mockClassifyWithNlp).not.toHaveBeenCalled();
    expect(result.classificationMethod).toBe('structured_edi');
    expect(result.guardrailIntervened).toBe(false);
    expect(result.classifiedDenial.claim_id).toBe('CLM001');
  });

  it('should route edi_277 to structured classifier', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({
      source_format: 'edi_277',
      SK: 'DENIAL#CLM001#edi_277',
    });

    mockClassifyStructuredEDI.mockResolvedValue({
      classifiedDenial: {
        PK: 'TENANT#tenant-1',
        SK: 'CLASSIFICATION#CLM001',
        claim_id: 'CLM001',
        carc_codes: [],
        rarc_codes: [],
        classification_method: 'structured_edi',
        dollar_ranking_available: false,
        review_status: 'auto_classified',
        classified_at: '2024-01-15T10:00:00Z',
      },
      unmappedCodes: [],
    });

    const result = await handler(denialRecord);

    expect(mockClassifyStructuredEDI).toHaveBeenCalled();
    expect(result.classificationMethod).toBe('structured_edi');
  });
});

// ─── Handler: NLP Routing ───────────────────────────────────────────────────

describe('handler - NLP routing', () => {
  it('should route pdf to NLP classifier', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({
      source_format: 'pdf',
      raw_denial_reason_text: 'Claim denied due to lack of medical necessity',
    });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [
        {
          code: 'CO-50',
          description: 'Non-covered services - not deemed medical necessity',
          confidence: 0.92,
          dollar_amount: null,
          rank: 1,
          required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE', 'MEDICAL_RECORDS'],
        },
      ],
      rarc_codes: [
        {
          code: 'N657',
          description: 'Based on internal clinical criteria',
          confidence: 0.85,
        },
      ],
      review_status: 'auto_classified',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    const result = await handler(denialRecord);

    expect(mockClassifyWithNlp).toHaveBeenCalledWith(denialRecord);
    expect(mockClassifyStructuredEDI).not.toHaveBeenCalled();
    expect(result.classificationMethod).toBe('bedrock_nlp');
    expect(result.guardrailIntervened).toBe(false);
    expect(result.classifiedDenial.carc_codes).toHaveLength(1);
    expect(result.classifiedDenial.rarc_codes).toHaveLength(1);
    expect(result.classifiedDenial.classification_method).toBe('bedrock_nlp');
  });

  it('should route tiff to NLP classifier', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'tiff' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    const result = await handler(denialRecord);

    expect(mockClassifyWithNlp).toHaveBeenCalled();
    expect(result.classificationMethod).toBe('bedrock_nlp');
  });

  it('should route png to NLP classifier', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'png' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    const result = await handler(denialRecord);

    expect(mockClassifyWithNlp).toHaveBeenCalled();
    expect(result.classificationMethod).toBe('bedrock_nlp');
  });

  it('should route jpeg to NLP classifier', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'jpeg' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    const result = await handler(denialRecord);

    expect(mockClassifyWithNlp).toHaveBeenCalled();
    expect(result.classificationMethod).toBe('bedrock_nlp');
  });

  it('should build ClassifiedDenial with correct PK/SK for NLP results', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({
      source_format: 'pdf',
      tenant_id: 'my-tenant',
      claim_id: 'CLM-999',
    });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    const result = await handler(denialRecord);

    expect(result.classifiedDenial.PK).toBe('TENANT#my-tenant');
    expect(result.classifiedDenial.SK).toBe('CLASSIFICATION#CLM-999');
    expect(result.classifiedDenial.claim_id).toBe('CLM-999');
  });

  it('should set classified_at timestamp for NLP results', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'pdf' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    const result = await handler(denialRecord);

    const timestamp = new Date(result.classifiedDenial.classified_at);
    expect(timestamp.getTime()).not.toBeNaN();
    // Should be recent (within last 5 seconds)
    expect(Date.now() - timestamp.getTime()).toBeLessThan(5000);
  });
});

// ─── Handler: DynamoDB Storage ──────────────────────────────────────────────

describe('handler - DynamoDB storage', () => {
  it('should store ClassifiedDenial in DynamoDB for structured classification', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'edi_835' });

    const classifiedDenial = {
      PK: 'TENANT#tenant-1',
      SK: 'CLASSIFICATION#CLM001',
      claim_id: 'CLM001',
      carc_codes: [
        {
          code: '45',
          description: 'Charge exceeds fee schedule',
          confidence: 1.0,
          dollar_amount: 100,
          rank: 1,
          required_evidence_categories: ['medical_necessity'],
        },
      ],
      rarc_codes: [],
      classification_method: 'structured_edi' as const,
      dollar_ranking_available: true,
      review_status: 'auto_classified' as const,
      classified_at: '2024-01-15T10:00:00Z',
    };

    mockClassifyStructuredEDI.mockResolvedValue({
      classifiedDenial,
      unmappedCodes: [],
    });

    await handler(denialRecord);

    expect(mockDynamo.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          TableName: 'TestTable',
          Item: classifiedDenial,
        },
      })
    );
  });

  it('should store ClassifiedDenial in DynamoDB for NLP classification', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'pdf' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [
        {
          code: 'CO-50',
          description: 'Not medical necessity',
          confidence: 0.92,
          dollar_amount: null,
          rank: 1,
          required_evidence_categories: ['DIAGNOSIS'],
        },
      ],
      rarc_codes: [],
      review_status: 'auto_classified',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    await handler(denialRecord);

    expect(mockDynamo.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: 'TestTable',
          Item: expect.objectContaining({
            PK: 'TENANT#tenant-1',
            SK: 'CLASSIFICATION#CLM001',
            claim_id: 'CLM001',
            classification_method: 'bedrock_nlp',
          }),
        }),
      })
    );
  });
});

// ─── Handler: Guardrail Intervention Logging ────────────────────────────────

describe('handler - guardrail intervention logging', () => {
  it('should log guardrail intervention when NLP classifier reports it', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });
    const consoleSpy = vi.spyOn(console, 'warn');

    const denialRecord = createMockDenialRecord({ source_format: 'pdf' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: true,
    });

    const result = await handler(denialRecord);

    expect(result.guardrailIntervened).toBe(true);

    // Verify structured guardrail log was emitted
    const guardrailLogCall = consoleSpy.mock.calls.find((call) => {
      const msg = typeof call[0] === 'string' ? call[0] : '';
      return msg.includes('GUARDRAIL_INTERVENTION');
    });
    expect(guardrailLogCall).toBeDefined();

    const logPayload = JSON.parse(guardrailLogCall![0] as string);
    expect(logPayload.event).toBe('GUARDRAIL_INTERVENTION');
    expect(logPayload.claim_id).toBe('CLM001');
    expect(logPayload.tenant_id).toBe('tenant-1');
    expect(logPayload.source_format).toBe('pdf');
    expect(logPayload.guardrail_id).toBe('test-guardrail-id');
    expect(logPayload.guardrail_version).toBe('1');

    consoleSpy.mockRestore();
  });

  it('should not log guardrail intervention when not triggered', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });
    const consoleSpy = vi.spyOn(console, 'warn');

    const denialRecord = createMockDenialRecord({ source_format: 'pdf' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [
        {
          code: 'CO-50',
          description: 'Not medical necessity',
          confidence: 0.92,
          dollar_amount: null,
          rank: 1,
          required_evidence_categories: ['DIAGNOSIS'],
        },
      ],
      rarc_codes: [],
      review_status: 'auto_classified',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    const result = await handler(denialRecord);

    expect(result.guardrailIntervened).toBe(false);

    const guardrailLogCall = consoleSpy.mock.calls.find((call) => {
      const msg = typeof call[0] === 'string' ? call[0] : '';
      return msg.includes('GUARDRAIL_INTERVENTION');
    });
    expect(guardrailLogCall).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it('should not log guardrail intervention for structured EDI classification', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });
    const consoleSpy = vi.spyOn(console, 'warn');

    const denialRecord = createMockDenialRecord({ source_format: 'edi_835' });

    mockClassifyStructuredEDI.mockResolvedValue({
      classifiedDenial: {
        PK: 'TENANT#tenant-1',
        SK: 'CLASSIFICATION#CLM001',
        claim_id: 'CLM001',
        carc_codes: [],
        rarc_codes: [],
        classification_method: 'structured_edi',
        dollar_ranking_available: false,
        review_status: 'auto_classified',
        classified_at: '2024-01-15T10:00:00Z',
      },
      unmappedCodes: [],
    });

    const result = await handler(denialRecord);

    expect(result.guardrailIntervened).toBe(false);

    const guardrailLogCall = consoleSpy.mock.calls.find((call) => {
      const msg = typeof call[0] === 'string' ? call[0] : '';
      return msg.includes('GUARDRAIL_INTERVENTION');
    });
    expect(guardrailLogCall).toBeUndefined();

    consoleSpy.mockRestore();
  });
});

// ─── Handler: Error Handling ────────────────────────────────────────────────

describe('handler - error handling', () => {
  it('should throw error for unsupported source format', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({
      source_format: 'unknown_format' as any,
    });

    await expect(handler(denialRecord)).rejects.toThrow(
      /Unsupported source_format/
    );
  });

  it('should propagate structured classifier errors', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'edi_835' });

    mockClassifyStructuredEDI.mockRejectedValue(
      new Error('Structured classifier failed')
    );

    await expect(handler(denialRecord)).rejects.toThrow(
      'Structured classifier failed'
    );
  });

  it('should propagate NLP classifier errors', async () => {
    const mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'pdf' });

    mockClassifyWithNlp.mockRejectedValue(
      new Error('Bedrock invocation failed')
    );

    await expect(handler(denialRecord)).rejects.toThrow(
      'Bedrock invocation failed'
    );
  });

  it('should propagate DynamoDB storage errors', async () => {
    const mockDynamo = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB write failed')),
    } as any;
    setClients({ dynamo: mockDynamo });

    const denialRecord = createMockDenialRecord({ source_format: 'pdf' });

    mockClassifyWithNlp.mockResolvedValue({
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    });

    await expect(handler(denialRecord)).rejects.toThrow(
      'DynamoDB write failed'
    );
  });
});
