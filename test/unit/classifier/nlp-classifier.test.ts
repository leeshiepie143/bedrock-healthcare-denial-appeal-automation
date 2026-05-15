/**
 * Unit tests for NLP Classifier Lambda
 *
 * Tests Bedrock prompt construction, response parsing, confidence routing,
 * guardrail handling, and edge cases with mocked Bedrock responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyWithNlp,
  buildClassificationPrompt,
  parseBedrockResponse,
  determineReviewStatus,
  getTopCandidates,
  invokeBedrockClassification,
  setBedrockClient,
  resetBedrockClient,
  CARC_REFERENCE,
  RARC_REFERENCE,
} from '@lambdas/classifier/nlp-classifier';
import type { DenialRecord, CarcCode } from '@shared/models';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function buildMockDenialRecord(overrides: Partial<DenialRecord> = {}): DenialRecord {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'DENIAL#CLM001#pdf',
    claim_id: 'CLM001',
    patient_id: 'PAT001',
    payer_id: 'PAY001',
    tenant_id: 'test-tenant',
    denial_date: '2024-01-15',
    denied_amount: 1500.00,
    raw_denial_reason_text: 'Services not medically necessary',
    source_format: 'pdf',
    source_s3_key: 'tenants/test-tenant/incoming/denial.pdf',
    ingestion_timestamp: '2024-01-15T10:00:00.000Z',
    status: 'ingested',
    workflow_execution_id: 'wf-001',
    ttl: 1737000000,
    ...overrides,
  };
}

function buildMockBedrockResponse(carcCodes: Array<{
  code: string;
  description: string;
  confidence: number;
  required_evidence_categories: string[];
}>, rarcCodes: Array<{
  code: string;
  description: string;
  confidence: number;
}> = []): string {
  const responseJson = {
    carc_codes: carcCodes,
    rarc_codes: rarcCodes,
  };
  return JSON.stringify(responseJson);
}

function createMockBedrockClient(responseText: string, options: {
  guardrailIntervened?: boolean;
  stopReason?: string;
} = {}): BedrockRuntimeClient {
  const responseBody = JSON.stringify({
    content: [{ type: 'text', text: responseText }],
    stop_reason: options.stopReason || 'end_turn',
    ...(options.guardrailIntervened ? { amazon_bedrock_guardrailAction: 'INTERVENED' } : {}),
  });

  return {
    send: vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(responseBody),
    }),
  } as unknown as BedrockRuntimeClient;
}

// ─── Prompt Construction Tests ──────────────────────────────────────────────

describe('buildClassificationPrompt', () => {
  it('includes the denial text in the prompt', () => {
    const prompt = buildClassificationPrompt('Services not medically necessary');
    expect(prompt).toContain('Services not medically necessary');
  });

  it('includes CARC code reference list', () => {
    const prompt = buildClassificationPrompt('test denial');
    expect(prompt).toContain('CO-50');
    expect(prompt).toContain('CO-197');
    expect(prompt).toContain('CARC Code Reference');
  });

  it('includes RARC code reference list', () => {
    const prompt = buildClassificationPrompt('test denial');
    expect(prompt).toContain('N115');
    expect(prompt).toContain('RARC Code Reference');
  });

  it('includes evidence categories in CARC reference', () => {
    const prompt = buildClassificationPrompt('test denial');
    expect(prompt).toContain('DIAGNOSIS');
    expect(prompt).toContain('PROCEDURE');
    expect(prompt).toContain('MEDICAL_RECORDS');
  });

  it('requests JSON response format', () => {
    const prompt = buildClassificationPrompt('test denial');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('required_evidence_categories');
  });

  it('includes all CARC reference codes', () => {
    const prompt = buildClassificationPrompt('test');
    for (const ref of CARC_REFERENCE) {
      expect(prompt).toContain(ref.code);
    }
  });

  it('includes all RARC reference codes', () => {
    const prompt = buildClassificationPrompt('test');
    for (const ref of RARC_REFERENCE) {
      expect(prompt).toContain(ref.code);
    }
  });
});

// ─── Response Parsing Tests ─────────────────────────────────────────────────

describe('parseBedrockResponse', () => {
  it('parses valid JSON response', () => {
    const responseText = buildMockBedrockResponse(
      [{ code: 'CO-50', description: 'Not medically necessary', confidence: 0.95, required_evidence_categories: ['DIAGNOSIS', 'MEDICAL_RECORDS'] }],
      [{ code: 'N115', description: 'Based on LCD', confidence: 0.85 }]
    );

    const result = parseBedrockResponse(responseText);
    expect(result).not.toBeNull();
    expect(result!.carc_codes).toHaveLength(1);
    expect(result!.carc_codes[0].code).toBe('CO-50');
    expect(result!.carc_codes[0].confidence).toBe(0.95);
    expect(result!.rarc_codes).toHaveLength(1);
    expect(result!.rarc_codes[0].code).toBe('N115');
  });

  it('parses JSON embedded in markdown code block', () => {
    const responseText = '```json\n' + buildMockBedrockResponse(
      [{ code: 'CO-197', description: 'Prior auth absent', confidence: 0.88, required_evidence_categories: ['AUTHORIZATION'] }],
      []
    ) + '\n```';

    const result = parseBedrockResponse(responseText);
    expect(result).not.toBeNull();
    expect(result!.carc_codes[0].code).toBe('CO-197');
  });

  it('parses JSON with surrounding text', () => {
    const json = buildMockBedrockResponse(
      [{ code: 'CO-45', description: 'Exceeds fee schedule', confidence: 0.72, required_evidence_categories: ['DOCUMENTATION'] }],
      []
    );
    const responseText = `Based on my analysis, here is the classification:\n${json}\nThis is my assessment.`;

    const result = parseBedrockResponse(responseText);
    expect(result).not.toBeNull();
    expect(result!.carc_codes[0].code).toBe('CO-45');
  });

  it('returns null for empty response', () => {
    expect(parseBedrockResponse('')).toBeNull();
    expect(parseBedrockResponse('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseBedrockResponse('not json at all')).toBeNull();
  });

  it('returns null for JSON missing carc_codes array', () => {
    const responseText = JSON.stringify({ rarc_codes: [] });
    expect(parseBedrockResponse(responseText)).toBeNull();
  });

  it('returns null for JSON missing rarc_codes array', () => {
    const responseText = JSON.stringify({ carc_codes: [] });
    expect(parseBedrockResponse(responseText)).toBeNull();
  });

  it('returns null for CARC code with invalid confidence (> 1)', () => {
    const responseText = buildMockBedrockResponse(
      [{ code: 'CO-50', description: 'Test', confidence: 1.5, required_evidence_categories: [] }],
      []
    );
    expect(parseBedrockResponse(responseText)).toBeNull();
  });

  it('returns null for CARC code with invalid confidence (< 0)', () => {
    const responseText = buildMockBedrockResponse(
      [{ code: 'CO-50', description: 'Test', confidence: -0.1, required_evidence_categories: [] }],
      []
    );
    expect(parseBedrockResponse(responseText)).toBeNull();
  });

  it('parses response with multiple CARC codes', () => {
    const responseText = buildMockBedrockResponse(
      [
        { code: 'CO-50', description: 'Not medically necessary', confidence: 0.92, required_evidence_categories: ['DIAGNOSIS'] },
        { code: 'CO-197', description: 'Prior auth absent', confidence: 0.75, required_evidence_categories: ['AUTHORIZATION'] },
      ],
      [{ code: 'N657', description: 'Internal criteria', confidence: 0.80 }]
    );

    const result = parseBedrockResponse(responseText);
    expect(result).not.toBeNull();
    expect(result!.carc_codes).toHaveLength(2);
    expect(result!.rarc_codes).toHaveLength(1);
  });

  it('accepts confidence of exactly 0.0', () => {
    const responseText = buildMockBedrockResponse(
      [{ code: 'CO-50', description: 'Test', confidence: 0.0, required_evidence_categories: [] }],
      []
    );
    const result = parseBedrockResponse(responseText);
    expect(result).not.toBeNull();
    expect(result!.carc_codes[0].confidence).toBe(0.0);
  });

  it('accepts confidence of exactly 1.0', () => {
    const responseText = buildMockBedrockResponse(
      [{ code: 'CO-50', description: 'Test', confidence: 1.0, required_evidence_categories: [] }],
      []
    );
    const result = parseBedrockResponse(responseText);
    expect(result).not.toBeNull();
    expect(result!.carc_codes[0].confidence).toBe(1.0);
  });
});

// ─── Confidence Routing Tests ───────────────────────────────────────────────

describe('determineReviewStatus', () => {
  it('returns auto_classified when highest confidence >= 0.8', () => {
    const codes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.85, dollar_amount: null, rank: 1, required_evidence_categories: [] },
    ];
    expect(determineReviewStatus(codes)).toBe('auto_classified');
  });

  it('returns auto_classified at exactly 0.8 confidence', () => {
    const codes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.8, dollar_amount: null, rank: 1, required_evidence_categories: [] },
    ];
    expect(determineReviewStatus(codes)).toBe('auto_classified');
  });

  it('returns pending_review when highest confidence < 0.8', () => {
    const codes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.79, dollar_amount: null, rank: 1, required_evidence_categories: [] },
      { code: 'CO-197', description: 'Test2', confidence: 0.65, dollar_amount: null, rank: 2, required_evidence_categories: [] },
    ];
    expect(determineReviewStatus(codes)).toBe('pending_review');
  });

  it('returns unprocessable when no CARC codes', () => {
    expect(determineReviewStatus([])).toBe('unprocessable');
  });

  it('uses highest confidence among multiple codes', () => {
    const codes: CarcCode[] = [
      { code: 'CO-50', description: 'Test', confidence: 0.6, dollar_amount: null, rank: 1, required_evidence_categories: [] },
      { code: 'CO-197', description: 'Test2', confidence: 0.82, dollar_amount: null, rank: 2, required_evidence_categories: [] },
      { code: 'CO-45', description: 'Test3', confidence: 0.5, dollar_amount: null, rank: 3, required_evidence_categories: [] },
    ];
    expect(determineReviewStatus(codes)).toBe('auto_classified');
  });
});

describe('getTopCandidates', () => {
  it('returns top 3 candidates sorted by confidence', () => {
    const codes: CarcCode[] = [
      { code: 'CO-50', description: 'A', confidence: 0.6, dollar_amount: null, rank: 1, required_evidence_categories: [] },
      { code: 'CO-197', description: 'B', confidence: 0.75, dollar_amount: null, rank: 2, required_evidence_categories: [] },
      { code: 'CO-45', description: 'C', confidence: 0.5, dollar_amount: null, rank: 3, required_evidence_categories: [] },
      { code: 'CO-96', description: 'D', confidence: 0.7, dollar_amount: null, rank: 4, required_evidence_categories: [] },
    ];

    const result = getTopCandidates(codes);
    expect(result).toHaveLength(3);
    expect(result[0].code).toBe('CO-197'); // 0.75
    expect(result[1].code).toBe('CO-96');  // 0.70
    expect(result[2].code).toBe('CO-50');  // 0.60
  });

  it('returns all codes when fewer than 3', () => {
    const codes: CarcCode[] = [
      { code: 'CO-50', description: 'A', confidence: 0.6, dollar_amount: null, rank: 1, required_evidence_categories: [] },
      { code: 'CO-197', description: 'B', confidence: 0.75, dollar_amount: null, rank: 2, required_evidence_categories: [] },
    ];

    const result = getTopCandidates(codes);
    expect(result).toHaveLength(2);
    expect(result[0].code).toBe('CO-197');
    expect(result[1].code).toBe('CO-50');
  });

  it('returns empty array for empty input', () => {
    expect(getTopCandidates([])).toHaveLength(0);
  });

  it('does not mutate the original array', () => {
    const codes: CarcCode[] = [
      { code: 'CO-50', description: 'A', confidence: 0.6, dollar_amount: null, rank: 1, required_evidence_categories: [] },
      { code: 'CO-197', description: 'B', confidence: 0.75, dollar_amount: null, rank: 2, required_evidence_categories: [] },
    ];
    const originalOrder = [...codes];
    getTopCandidates(codes);
    expect(codes[0].code).toBe(originalOrder[0].code);
    expect(codes[1].code).toBe(originalOrder[1].code);
  });
});

// ─── Bedrock Invocation Tests ───────────────────────────────────────────────

describe('invokeBedrockClassification', () => {
  beforeEach(() => {
    process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-sonnet-20240229-v1:0';
    process.env.GUARDRAIL_ID = 'test-guardrail-id';
    process.env.GUARDRAIL_VERSION = '1';
  });

  afterEach(() => {
    resetBedrockClient();
    delete process.env.BEDROCK_MODEL_ID;
    delete process.env.GUARDRAIL_ID;
    delete process.env.GUARDRAIL_VERSION;
  });

  it('returns parsed response text from Bedrock', async () => {
    const classificationJson = buildMockBedrockResponse(
      [{ code: 'CO-50', description: 'Not medically necessary', confidence: 0.92, required_evidence_categories: ['DIAGNOSIS'] }],
      []
    );
    const mockClient = createMockBedrockClient(classificationJson);
    setBedrockClient(mockClient);

    const result = await invokeBedrockClassification('Services not medically necessary');
    expect(result.responseBody).toBe(classificationJson);
    expect(result.guardrailIntervened).toBe(false);
  });

  it('detects guardrail intervention via amazon_bedrock_guardrailAction', async () => {
    const mockClient = createMockBedrockClient('', { guardrailIntervened: true });
    setBedrockClient(mockClient);

    const result = await invokeBedrockClassification('test text');
    expect(result.guardrailIntervened).toBe(true);
  });

  it('detects guardrail intervention via stop_reason', async () => {
    const responseBody = JSON.stringify({
      content: [{ type: 'text', text: '' }],
      stop_reason: 'guardrail_intervened',
    });

    const mockClient = {
      send: vi.fn().mockResolvedValue({
        body: new TextEncoder().encode(responseBody),
      }),
    } as unknown as BedrockRuntimeClient;
    setBedrockClient(mockClient);

    const result = await invokeBedrockClassification('test text');
    expect(result.guardrailIntervened).toBe(true);
  });

  it('passes guardrail parameters in the request', async () => {
    const mockClient = createMockBedrockClient('{}');
    setBedrockClient(mockClient);

    await invokeBedrockClassification('test text');

    const sendCall = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendCall.input.guardrailIdentifier).toBe('test-guardrail-id');
    expect(sendCall.input.guardrailVersion).toBe('1');
  });

  it('omits guardrail parameters when GUARDRAIL_ID is not set', async () => {
    delete process.env.GUARDRAIL_ID;
    const mockClient = createMockBedrockClient('{}');
    setBedrockClient(mockClient);

    await invokeBedrockClassification('test text');

    const sendCall = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendCall.input.guardrailIdentifier).toBeUndefined();
    expect(sendCall.input.guardrailVersion).toBeUndefined();
  });
});

// ─── End-to-End Classification Tests ────────────────────────────────────────

describe('classifyWithNlp', () => {
  beforeEach(() => {
    process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-sonnet-20240229-v1:0';
    process.env.GUARDRAIL_ID = 'test-guardrail-id';
    process.env.GUARDRAIL_VERSION = '1';
  });

  afterEach(() => {
    resetBedrockClient();
    delete process.env.BEDROCK_MODEL_ID;
    delete process.env.GUARDRAIL_ID;
    delete process.env.GUARDRAIL_VERSION;
  });

  it('returns unprocessable for empty denial text', async () => {
    const record = buildMockDenialRecord({ raw_denial_reason_text: '' });
    const result = await classifyWithNlp(record);

    expect(result.review_status).toBe('unprocessable');
    expect(result.carc_codes).toHaveLength(0);
    expect(result.rarc_codes).toHaveLength(0);
    expect(result.classification_method).toBe('bedrock_nlp');
  });

  it('returns unprocessable for whitespace-only denial text', async () => {
    const record = buildMockDenialRecord({ raw_denial_reason_text: '   \n\t  ' });
    const result = await classifyWithNlp(record);

    expect(result.review_status).toBe('unprocessable');
    expect(result.carc_codes).toHaveLength(0);
  });

  it('returns auto_classified for high-confidence result', async () => {
    const classificationJson = buildMockBedrockResponse(
      [{ code: 'CO-50', description: 'Not medically necessary', confidence: 0.92, required_evidence_categories: ['DIAGNOSIS', 'MEDICAL_RECORDS'] }],
      [{ code: 'N115', description: 'Based on LCD', confidence: 0.85 }]
    );
    const mockClient = createMockBedrockClient(classificationJson);
    setBedrockClient(mockClient);

    const record = buildMockDenialRecord({ raw_denial_reason_text: 'Services not medically necessary' });
    const result = await classifyWithNlp(record);

    expect(result.review_status).toBe('auto_classified');
    expect(result.carc_codes).toHaveLength(1);
    expect(result.carc_codes[0].code).toBe('CO-50');
    expect(result.carc_codes[0].confidence).toBe(0.92);
    expect(result.carc_codes[0].dollar_amount).toBeNull();
    expect(result.carc_codes[0].rank).toBe(1);
    expect(result.rarc_codes).toHaveLength(1);
    expect(result.rarc_codes[0].code).toBe('N115');
  });

  it('returns pending_review with top 3 candidates for low confidence', async () => {
    const classificationJson = buildMockBedrockResponse(
      [
        { code: 'CO-50', description: 'Not medically necessary', confidence: 0.65, required_evidence_categories: ['DIAGNOSIS'] },
        { code: 'CO-96', description: 'Non-covered', confidence: 0.55, required_evidence_categories: ['DOCUMENTATION'] },
        { code: 'CO-167', description: 'Diagnosis not covered', confidence: 0.45, required_evidence_categories: ['DIAGNOSIS'] },
        { code: 'CO-204', description: 'Not covered under plan', confidence: 0.35, required_evidence_categories: ['DOCUMENTATION'] },
      ],
      []
    );
    const mockClient = createMockBedrockClient(classificationJson);
    setBedrockClient(mockClient);

    const record = buildMockDenialRecord({ raw_denial_reason_text: 'Claim denied for coverage reasons' });
    const result = await classifyWithNlp(record);

    expect(result.review_status).toBe('pending_review');
    expect(result.carc_codes).toHaveLength(3); // Top 3 only
    expect(result.carc_codes[0].confidence).toBeGreaterThanOrEqual(result.carc_codes[1].confidence);
    expect(result.carc_codes[1].confidence).toBeGreaterThanOrEqual(result.carc_codes[2].confidence);
  });

  it('returns unprocessable when Bedrock response is unparseable', async () => {
    const mockClient = createMockBedrockClient('This is not valid JSON at all');
    setBedrockClient(mockClient);

    const record = buildMockDenialRecord({ raw_denial_reason_text: 'Some denial reason' });
    const result = await classifyWithNlp(record);

    expect(result.review_status).toBe('unprocessable');
    expect(result.carc_codes).toHaveLength(0);
  });

  it('returns unprocessable when guardrail blocks completely', async () => {
    const mockClient = createMockBedrockClient('', { guardrailIntervened: true });
    setBedrockClient(mockClient);

    const record = buildMockDenialRecord({ raw_denial_reason_text: 'Some denial reason' });
    const result = await classifyWithNlp(record);

    expect(result.review_status).toBe('unprocessable');
    expect(result.guardrail_intervened).toBe(true);
  });

  it('sets classification_method to bedrock_nlp', async () => {
    const classificationJson = buildMockBedrockResponse(
      [{ code: 'CO-197', description: 'Prior auth absent', confidence: 0.90, required_evidence_categories: ['AUTHORIZATION'] }],
      []
    );
    const mockClient = createMockBedrockClient(classificationJson);
    setBedrockClient(mockClient);

    const record = buildMockDenialRecord({ raw_denial_reason_text: 'Prior authorization was not obtained' });
    const result = await classifyWithNlp(record);

    expect(result.classification_method).toBe('bedrock_nlp');
  });

  it('assigns sequential ranks to CARC codes', async () => {
    const classificationJson = buildMockBedrockResponse(
      [
        { code: 'CO-50', description: 'Not medically necessary', confidence: 0.92, required_evidence_categories: ['DIAGNOSIS'] },
        { code: 'CO-197', description: 'Prior auth absent', confidence: 0.85, required_evidence_categories: ['AUTHORIZATION'] },
      ],
      []
    );
    const mockClient = createMockBedrockClient(classificationJson);
    setBedrockClient(mockClient);

    const record = buildMockDenialRecord({ raw_denial_reason_text: 'Not medically necessary, no prior auth' });
    const result = await classifyWithNlp(record);

    expect(result.carc_codes[0].rank).toBe(1);
    expect(result.carc_codes[1].rank).toBe(2);
  });

  it('handles Bedrock response with empty carc_codes array', async () => {
    const classificationJson = buildMockBedrockResponse([], []);
    const mockClient = createMockBedrockClient(classificationJson);
    setBedrockClient(mockClient);

    const record = buildMockDenialRecord({ raw_denial_reason_text: 'Unclear denial reason' });
    const result = await classifyWithNlp(record);

    expect(result.review_status).toBe('unprocessable');
    expect(result.carc_codes).toHaveLength(0);
  });
});
