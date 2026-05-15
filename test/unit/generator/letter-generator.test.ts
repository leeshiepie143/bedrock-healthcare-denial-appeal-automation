/**
 * Unit tests for Appeal Letter Generator Lambda
 *
 * Tests template selection, Bedrock prompt construction, response parsing,
 * guardrail handling, metadata generation, and incomplete section detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateAppealLetter,
  selectTemplate,
  loadPayerTemplate,
  buildSystemPrompt,
  buildUserPrompt,
  invokeBedrockGeneration,
  parseGeneratedLetter,
  buildFallbackMetadata,
  detectIncompleteSections,
  setBedrockClient,
  resetBedrockClient,
  setS3Client,
  resetS3Client,
  DEFAULT_TEMPLATE,
  type LetterGenerationInput,
  type PayerTemplate,
} from '@lambdas/generator/letter-generator';
import type {
  ViabilityAssessment,
  EvidencePackage,
  ClassifiedDenial,
  DenialRecord,
  RegulatoryCitation,
} from '@shared/models';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { S3Client } from '@aws-sdk/client-s3';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function buildMockDenialRecord(overrides: Partial<DenialRecord> = {}): DenialRecord {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'DENIAL#CLM001#pdf',
    claim_id: 'CLM001',
    patient_id: 'PAT001',
    payer_id: 'PAY001',
    tenant_id: 'test-tenant',
    denial_date: '2024-03-15',
    denied_amount: 2500.00,
    raw_denial_reason_text: 'Services not medically necessary',
    source_format: 'pdf',
    source_s3_key: 'tenants/test-tenant/incoming/denial.pdf',
    ingestion_timestamp: '2024-03-15T10:00:00.000Z',
    status: 'assessed',
    workflow_execution_id: 'wf-001',
    ttl: 1737000000,
    ...overrides,
  };
}

function buildMockClassifiedDenial(overrides: Partial<ClassifiedDenial> = {}): ClassifiedDenial {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'CLASSIFICATION#CLM001',
    claim_id: 'CLM001',
    carc_codes: [
      {
        code: 'CO-50',
        description: 'Not deemed medically necessary by the payer',
        confidence: 0.92,
        dollar_amount: 2500.00,
        rank: 1,
        required_evidence_categories: ['DIAGNOSIS', 'PROCEDURE', 'MEDICAL_RECORDS'],
      },
    ],
    rarc_codes: [
      {
        code: 'N115',
        description: 'This decision was based on a Local Coverage Determination (LCD)',
        confidence: 0.85,
      },
    ],
    classification_method: 'bedrock_nlp',
    dollar_ranking_available: true,
    review_status: 'auto_classified',
    classified_at: '2024-03-15T10:05:00.000Z',
    ...overrides,
  };
}

function buildMockEvidencePackage(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'EVIDENCE#CLM001',
    claim_id: 'CLM001',
    patient_id: 'PAT001',
    evidence_items: [
      {
        fhir_resource_id: 'Encounter/enc-001',
        fhir_resource_type: 'Encounter',
        date: '2024-03-10',
        authoring_provider: 'Dr. Smith',
        relevance_score: 0.85,
        extracted_entities: [
          { text: 'Type 2 Diabetes', category: 'DIAGNOSIS', icd_code: 'E11.9', confidence: 0.95 },
        ],
        mapped_denial_reasons: ['CO-50'],
      },
      {
        fhir_resource_id: 'Procedure/proc-001',
        fhir_resource_type: 'Procedure',
        date: '2024-03-12',
        authoring_provider: 'Dr. Johnson',
        relevance_score: 0.78,
        extracted_entities: [
          { text: 'HbA1c Test', category: 'PROCEDURE', icd_code: null, confidence: 0.90 },
        ],
        mapped_denial_reasons: ['CO-50'],
      },
    ],
    total_evidence_count: 2,
    retrieval_timestamp: '2024-03-15T10:10:00.000Z',
    retrieval_duration_ms: 1200,
    manual_review_required: false,
    ...overrides,
  };
}

function buildMockViabilityAssessment(overrides: Partial<ViabilityAssessment> = {}): ViabilityAssessment {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'VIABILITY#CLM001',
    claim_id: 'CLM001',
    viability_score: 0.72,
    confidence_interval: { lower: 0.55, upper: 0.85, confidence_level: 0.90 },
    recommendation: 'pursue',
    rationale: [
      { factor: 'Historical overturn rate', impact: 'positive', weight: 0.30 },
      { factor: 'Clinical evidence strength', impact: 'positive', weight: 0.25 },
    ],
    top_evidence_items: ['Encounter/enc-001', 'Procedure/proc-001'],
    inputs: {
      denial_reason_code: 'CO-50',
      payer_id: 'PAY001',
      historical_overturn_rate: 0.65,
      evidence_score: 0.82,
      claim_amount: 2500.00,
      days_to_deadline: 45,
    },
    limited_historical_data: false,
    deadline_expired: false,
    assessed_at: '2024-03-15T10:15:00.000Z',
    ...overrides,
  };
}

function buildMockInput(overrides: Partial<LetterGenerationInput> = {}): LetterGenerationInput {
  return {
    viabilityAssessment: buildMockViabilityAssessment(),
    evidencePackage: buildMockEvidencePackage(),
    classifiedDenial: buildMockClassifiedDenial(),
    denialRecord: buildMockDenialRecord(),
    regulatoryCitations: [
      {
        type: 'lcd',
        reference_id: 'L33831',
        section: '4.2',
        description: 'Coverage criteria for diabetes management services',
      },
    ],
    ...overrides,
  };
}

function buildMockPayerTemplate(): PayerTemplate {
  return {
    payer_id: 'PAY001',
    payer_name: 'Blue Cross Blue Shield',
    letter_structure: [
      'header',
      'patient_identification',
      'claim_identification',
      'denial_reason_statement',
      'clinical_justification',
      'regulatory_references',
      'request_for_reconsideration',
      'closing',
    ],
    required_sections: [
      'patient_identification',
      'claim_identification',
      'denial_reason_statement',
      'clinical_justification',
      'request_for_reconsideration',
    ],
    formatting_rules: {
      salutation: 'Dear BCBS Appeals Committee',
      closing: 'Respectfully submitted',
      address_format: 'standard',
    },
    address_info: {
      appeals_department: 'BCBS Appeals Department',
      street: '123 Insurance Ave',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
    },
  };
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

function createMockS3Client(responseBody: string | null, error?: Error): S3Client {
  if (error) {
    return {
      send: vi.fn().mockRejectedValue(error),
    } as unknown as S3Client;
  }

  return {
    send: vi.fn().mockResolvedValue({
      Body: responseBody
        ? { transformToString: vi.fn().mockResolvedValue(responseBody) }
        : undefined,
    }),
  } as unknown as S3Client;
}

function buildSampleLetterResponse(): string {
  const letterBody = `Dear Appeals Department,

I am writing to formally appeal the denial of claim CLM001 for patient PAT001.

The claim for services rendered on 2024-03-15 in the amount of $2,500.00 was denied under CARC code CO-50 (not deemed medically necessary).

Clinical evidence supports the medical necessity of these services:
- Encounter/enc-001 dated 2024-03-10 by Dr. Smith documents Type 2 Diabetes (E11.9)
- Procedure/proc-001 dated 2024-03-12 by Dr. Johnson documents HbA1c Test

Per LCD L33831, Section 4.2, diabetes management services meet coverage criteria when supported by documented diagnosis and monitoring.

We respectfully request that this claim be reprocessed and the denial overturned based on the clinical evidence provided.

Sincerely,
Revenue Cycle Department`;

  const metadata = JSON.stringify({
    patient_id: 'PAT001',
    claim_id: 'CLM001',
    denial_reasons: ['CO-50'],
    cited_evidence_references: [
      { fhir_resource_id: 'Encounter/enc-001', date: '2024-03-10', provider: 'Dr. Smith' },
      { fhir_resource_id: 'Procedure/proc-001', date: '2024-03-12', provider: 'Dr. Johnson' },
    ],
    regulatory_citations: [
      { type: 'lcd', reference_id: 'L33831', section: '4.2', description: 'Coverage criteria for diabetes management services' },
    ],
    appeal_arguments: [
      'Clinical evidence supports medical necessity',
      'LCD L33831 Section 4.2 criteria met',
    ],
  }, null, 2);

  return `${letterBody}\n\n---METADATA---\n${metadata}\n---END_METADATA---`;
}

// ─── Template Selection Tests ───────────────────────────────────────────────

describe('loadPayerTemplate', () => {
  beforeEach(() => {
    process.env.TEMPLATE_BUCKET = 'test-template-bucket';
  });

  afterEach(() => {
    resetS3Client();
    delete process.env.TEMPLATE_BUCKET;
  });

  it('returns null when TEMPLATE_BUCKET is not set', async () => {
    delete process.env.TEMPLATE_BUCKET;
    const result = await loadPayerTemplate('PAY001');
    expect(result).toBeNull();
  });

  it('loads and returns a valid payer template from S3', async () => {
    const template = buildMockPayerTemplate();
    const mockClient = createMockS3Client(JSON.stringify(template));
    setS3Client(mockClient);

    const result = await loadPayerTemplate('PAY001');
    expect(result).not.toBeNull();
    expect(result!.payer_id).toBe('PAY001');
    expect(result!.payer_name).toBe('Blue Cross Blue Shield');
  });

  it('returns null when S3 returns NoSuchKey', async () => {
    const error = new Error('NoSuchKey') as Error & { name: string };
    error.name = 'NoSuchKey';
    const mockClient = createMockS3Client(null, error);
    setS3Client(mockClient);

    const result = await loadPayerTemplate('UNKNOWN_PAYER');
    expect(result).toBeNull();
  });

  it('returns null when S3 response body is empty', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Body: undefined,
      }),
    } as unknown as S3Client;
    setS3Client(mockClient);

    const result = await loadPayerTemplate('PAY001');
    expect(result).toBeNull();
  });

  it('returns null for invalid template structure (missing required fields)', async () => {
    const invalidTemplate = { payer_id: 'PAY001' }; // missing letter_structure and required_sections
    const mockClient = createMockS3Client(JSON.stringify(invalidTemplate));
    setS3Client(mockClient);

    const result = await loadPayerTemplate('PAY001');
    expect(result).toBeNull();
  });
});

describe('selectTemplate', () => {
  beforeEach(() => {
    process.env.TEMPLATE_BUCKET = 'test-template-bucket';
  });

  afterEach(() => {
    resetS3Client();
    delete process.env.TEMPLATE_BUCKET;
  });

  it('returns payer template when available', async () => {
    const template = buildMockPayerTemplate();
    const mockClient = createMockS3Client(JSON.stringify(template));
    setS3Client(mockClient);

    const result = await selectTemplate('PAY001');
    expect(result.payerTemplateAvailable).toBe(true);
    expect(result.template.payer_id).toBe('PAY001');
  });

  it('returns default template when payer template not found', async () => {
    const error = new Error('NoSuchKey') as Error & { name: string };
    error.name = 'NoSuchKey';
    const mockClient = createMockS3Client(null, error);
    setS3Client(mockClient);

    const result = await selectTemplate('UNKNOWN_PAYER');
    expect(result.payerTemplateAvailable).toBe(false);
    expect(result.template).toEqual(DEFAULT_TEMPLATE);
  });
});


// ─── Prompt Construction Tests ──────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('includes healthcare revenue cycle specialist role', () => {
    const prompt = buildSystemPrompt(DEFAULT_TEMPLATE);
    expect(prompt).toContain('healthcare revenue cycle specialist');
  });

  it('includes instruction to not fabricate citations', () => {
    const prompt = buildSystemPrompt(DEFAULT_TEMPLATE);
    expect(prompt).toContain('ONLY cite clinical evidence from the provided evidence list');
    expect(prompt).toContain('NEVER invent clinical facts');
  });

  it('includes template structure sections', () => {
    const template = buildMockPayerTemplate();
    const prompt = buildSystemPrompt(template);
    expect(prompt).toContain('clinical_justification');
    expect(prompt).toContain('request_for_reconsideration');
  });

  it('includes payer-specific salutation', () => {
    const template = buildMockPayerTemplate();
    const prompt = buildSystemPrompt(template);
    expect(prompt).toContain('Dear BCBS Appeals Committee');
  });

  it('includes closing instruction', () => {
    const template = buildMockPayerTemplate();
    const prompt = buildSystemPrompt(template);
    expect(prompt).toContain('Respectfully submitted');
  });
});

describe('buildUserPrompt', () => {
  it('includes patient demographics', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('PAT001');
    expect(prompt).toContain('CLM001');
    expect(prompt).toContain('2024-03-15');
    expect(prompt).toContain('$2500.00');
  });

  it('includes denial reasons with CARC codes', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('CO-50');
    expect(prompt).toContain('Not deemed medically necessary');
  });

  it('includes RARC codes', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('N115');
    expect(prompt).toContain('Local Coverage Determination');
  });

  it('includes clinical evidence with FHIR resource IDs', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('Encounter/enc-001');
    expect(prompt).toContain('Procedure/proc-001');
    expect(prompt).toContain('Dr. Smith');
    expect(prompt).toContain('Dr. Johnson');
  });

  it('includes evidence dates and relevance scores', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('2024-03-10');
    expect(prompt).toContain('2024-03-12');
    expect(prompt).toContain('0.85');
  });

  it('includes extracted entities with ICD codes', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('Type 2 Diabetes');
    expect(prompt).toContain('E11.9');
    expect(prompt).toContain('HbA1c Test');
  });

  it('includes regulatory citations when provided', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('L33831');
    expect(prompt).toContain('Section 4.2');
    expect(prompt).toContain('diabetes management services');
  });

  it('omits regulatory section when no citations provided', () => {
    const input = buildMockInput({ regulatoryCitations: undefined });
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).not.toContain('Regulatory References');
  });

  it('includes metadata output format instructions', () => {
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('---METADATA---');
    expect(prompt).toContain('---END_METADATA---');
    expect(prompt).toContain('cited_evidence_references');
    expect(prompt).toContain('appeal_arguments');
  });

  it('includes payer address when available in template', () => {
    const template = buildMockPayerTemplate();
    const input = buildMockInput();
    const prompt = buildUserPrompt(input, template);
    expect(prompt).toContain('123 Insurance Ave');
    expect(prompt).toContain('Chicago');
    expect(prompt).toContain('IL');
  });

  it('handles empty evidence items gracefully', () => {
    const input = buildMockInput({
      evidencePackage: buildMockEvidencePackage({ evidence_items: [] }),
    });
    const prompt = buildUserPrompt(input, DEFAULT_TEMPLATE);
    expect(prompt).toContain('No clinical evidence available');
  });
});

// ─── Response Parsing Tests ─────────────────────────────────────────────────

describe('parseGeneratedLetter', () => {
  it('parses letter body and metadata from well-formed response', () => {
    const response = buildSampleLetterResponse();
    const result = parseGeneratedLetter(response);

    expect(result.letterBody).toContain('Dear Appeals Department');
    expect(result.letterBody).toContain('Revenue Cycle Department');
    expect(result.metadata).not.toBeNull();
    expect(result.metadata!.patient_id).toBe('PAT001');
    expect(result.metadata!.claim_id).toBe('CLM001');
    expect(result.metadata!.denial_reasons).toContain('CO-50');
    expect(result.metadata!.cited_evidence_references).toHaveLength(2);
    expect(result.metadata!.regulatory_citations).toHaveLength(1);
    expect(result.metadata!.appeal_arguments).toHaveLength(2);
  });

  it('returns entire response as letter body when no metadata markers', () => {
    const response = 'Dear Appeals Department,\n\nThis is an appeal letter without metadata.';
    const result = parseGeneratedLetter(response);

    expect(result.letterBody).toBe(response);
    expect(result.metadata).toBeNull();
  });

  it('returns empty letter body and null metadata for empty input', () => {
    const result = parseGeneratedLetter('');
    expect(result.letterBody).toBe('');
    expect(result.metadata).toBeNull();
  });

  it('returns letter body with null metadata when metadata JSON is invalid', () => {
    const response = 'Dear Appeals Department,\n\n---METADATA---\n{invalid json}\n---END_METADATA---';
    const result = parseGeneratedLetter(response);

    expect(result.letterBody).toBe('Dear Appeals Department,');
    expect(result.metadata).toBeNull();
  });

  it('validates metadata structure - rejects missing patient_id', () => {
    const metadata = JSON.stringify({
      claim_id: 'CLM001',
      denial_reasons: ['CO-50'],
      cited_evidence_references: [],
      regulatory_citations: [],
      appeal_arguments: [],
    });
    const response = `Letter body\n\n---METADATA---\n${metadata}\n---END_METADATA---`;
    const result = parseGeneratedLetter(response);

    expect(result.letterBody).toBe('Letter body');
    expect(result.metadata).toBeNull();
  });

  it('filters invalid cited_evidence_references entries', () => {
    const metadata = JSON.stringify({
      patient_id: 'PAT001',
      claim_id: 'CLM001',
      denial_reasons: ['CO-50'],
      cited_evidence_references: [
        { fhir_resource_id: 'Encounter/enc-001', date: '2024-03-10', provider: 'Dr. Smith' },
        { invalid: 'entry' },
        { fhir_resource_id: 'Procedure/proc-001', date: '2024-03-12', provider: 'Dr. Johnson' },
      ],
      regulatory_citations: [],
      appeal_arguments: ['Argument 1'],
    });
    const response = `Letter body\n\n---METADATA---\n${metadata}\n---END_METADATA---`;
    const result = parseGeneratedLetter(response);

    expect(result.metadata).not.toBeNull();
    expect(result.metadata!.cited_evidence_references).toHaveLength(2);
  });
});

// ─── Fallback Metadata Tests ────────────────────────────────────────────────

describe('buildFallbackMetadata', () => {
  it('constructs metadata from input data', () => {
    const input = buildMockInput();
    const metadata = buildFallbackMetadata(input);

    expect(metadata.patient_id).toBe('PAT001');
    expect(metadata.claim_id).toBe('CLM001');
    expect(metadata.denial_reasons).toContain('CO-50');
    expect(metadata.cited_evidence_references).toHaveLength(2);
    expect(metadata.cited_evidence_references[0].fhir_resource_id).toBe('Encounter/enc-001');
    expect(metadata.cited_evidence_references[0].date).toBe('2024-03-10');
    expect(metadata.cited_evidence_references[0].provider).toBe('Dr. Smith');
  });

  it('includes regulatory citations when provided', () => {
    const input = buildMockInput();
    const metadata = buildFallbackMetadata(input);

    expect(metadata.regulatory_citations).toHaveLength(1);
    expect(metadata.regulatory_citations[0].reference_id).toBe('L33831');
  });

  it('returns empty regulatory citations when none provided', () => {
    const input = buildMockInput({ regulatoryCitations: undefined });
    const metadata = buildFallbackMetadata(input);

    expect(metadata.regulatory_citations).toHaveLength(0);
  });

  it('generates appeal arguments from CARC codes', () => {
    const input = buildMockInput();
    const metadata = buildFallbackMetadata(input);

    expect(metadata.appeal_arguments).toHaveLength(1);
    expect(metadata.appeal_arguments[0]).toContain('CO-50');
  });
});

// ─── Incomplete Section Detection Tests ─────────────────────────────────────

describe('detectIncompleteSections', () => {
  it('returns empty array when all sections have data', () => {
    const input = buildMockInput();
    const result = detectIncompleteSections(input, DEFAULT_TEMPLATE);
    expect(result).toHaveLength(0);
  });

  it('flags clinical_justification when no evidence items', () => {
    const input = buildMockInput({
      evidencePackage: buildMockEvidencePackage({ evidence_items: [] }),
    });
    const result = detectIncompleteSections(input, DEFAULT_TEMPLATE);
    expect(result).toContain('clinical_justification');
  });

  it('flags regulatory_references when template requires it but none provided', () => {
    const template: PayerTemplate = {
      ...DEFAULT_TEMPLATE,
      required_sections: [...DEFAULT_TEMPLATE.required_sections, 'regulatory_references'],
    };
    const input = buildMockInput({ regulatoryCitations: undefined });
    const result = detectIncompleteSections(input, template);
    expect(result).toContain('regulatory_references');
  });

  it('does not flag regulatory_references when not in required_sections', () => {
    const input = buildMockInput({ regulatoryCitations: undefined });
    const result = detectIncompleteSections(input, DEFAULT_TEMPLATE);
    expect(result).not.toContain('regulatory_references');
  });
});

// ─── Bedrock Invocation Tests ───────────────────────────────────────────────

describe('invokeBedrockGeneration', () => {
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

  it('returns response text from Bedrock', async () => {
    const letterText = 'Dear Appeals Department, this is a test letter.';
    const mockClient = createMockBedrockClient(letterText);
    setBedrockClient(mockClient);

    const result = await invokeBedrockGeneration('system prompt', 'user prompt');
    expect(result.responseBody).toBe(letterText);
    expect(result.guardrailIntervened).toBe(false);
  });

  it('detects guardrail intervention', async () => {
    const mockClient = createMockBedrockClient('', { guardrailIntervened: true });
    setBedrockClient(mockClient);

    const result = await invokeBedrockGeneration('system prompt', 'user prompt');
    expect(result.guardrailIntervened).toBe(true);
  });

  it('passes guardrail parameters in the request', async () => {
    const mockClient = createMockBedrockClient('test');
    setBedrockClient(mockClient);

    await invokeBedrockGeneration('system prompt', 'user prompt');

    const sendCall = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendCall.input.guardrailIdentifier).toBe('test-guardrail-id');
    expect(sendCall.input.guardrailVersion).toBe('1');
  });

  it('omits guardrail parameters when GUARDRAIL_ID is not set', async () => {
    delete process.env.GUARDRAIL_ID;
    const mockClient = createMockBedrockClient('test');
    setBedrockClient(mockClient);

    await invokeBedrockGeneration('system prompt', 'user prompt');

    const sendCall = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendCall.input.guardrailIdentifier).toBeUndefined();
    expect(sendCall.input.guardrailVersion).toBeUndefined();
  });

  it('uses system prompt in the request body', async () => {
    const mockClient = createMockBedrockClient('test');
    setBedrockClient(mockClient);

    await invokeBedrockGeneration('My system prompt', 'My user prompt');

    const sendCall = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = JSON.parse(sendCall.input.body);
    expect(body.system).toBe('My system prompt');
    expect(body.messages[0].content).toBe('My user prompt');
  });
});

// ─── End-to-End Generation Tests ────────────────────────────────────────────

describe('generateAppealLetter', () => {
  beforeEach(() => {
    process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-sonnet-20240229-v1:0';
    process.env.GUARDRAIL_ID = 'test-guardrail-id';
    process.env.GUARDRAIL_VERSION = '1';
    process.env.TEMPLATE_BUCKET = 'test-template-bucket';
  });

  afterEach(() => {
    resetBedrockClient();
    resetS3Client();
    delete process.env.BEDROCK_MODEL_ID;
    delete process.env.GUARDRAIL_ID;
    delete process.env.GUARDRAIL_VERSION;
    delete process.env.TEMPLATE_BUCKET;
  });

  it('generates a complete letter with metadata using default template', async () => {
    // S3 returns NoSuchKey (no payer template)
    const s3Error = new Error('NoSuchKey') as Error & { name: string };
    s3Error.name = 'NoSuchKey';
    const mockS3 = createMockS3Client(null, s3Error);
    setS3Client(mockS3);

    // Bedrock returns a well-formed letter
    const mockBedrock = createMockBedrockClient(buildSampleLetterResponse());
    setBedrockClient(mockBedrock);

    const input = buildMockInput();
    const result = await generateAppealLetter(input);

    expect(result.letter_body).toContain('Dear Appeals Department');
    expect(result.metadata.patient_id).toBe('PAT001');
    expect(result.metadata.claim_id).toBe('CLM001');
    expect(result.template_used).toBe('default');
    expect(result.payer_template_available).toBe(false);
    expect(result.guardrail_intervened).toBe(false);
  });

  it('uses payer-specific template when available', async () => {
    const template = buildMockPayerTemplate();
    const mockS3 = createMockS3Client(JSON.stringify(template));
    setS3Client(mockS3);

    const mockBedrock = createMockBedrockClient(buildSampleLetterResponse());
    setBedrockClient(mockBedrock);

    const input = buildMockInput();
    const result = await generateAppealLetter(input);

    expect(result.template_used).toBe('payer:PAY001');
    expect(result.payer_template_available).toBe(true);
  });

  it('returns fallback metadata when Bedrock response has no metadata section', async () => {
    const s3Error = new Error('NoSuchKey') as Error & { name: string };
    s3Error.name = 'NoSuchKey';
    const mockS3 = createMockS3Client(null, s3Error);
    setS3Client(mockS3);

    const letterOnly = 'Dear Appeals Department,\n\nThis is a letter without metadata markers.';
    const mockBedrock = createMockBedrockClient(letterOnly);
    setBedrockClient(mockBedrock);

    const input = buildMockInput();
    const result = await generateAppealLetter(input);

    expect(result.letter_body).toContain('Dear Appeals Department');
    expect(result.metadata.patient_id).toBe('PAT001');
    expect(result.metadata.claim_id).toBe('CLM001');
    expect(result.metadata.denial_reasons).toContain('CO-50');
    expect(result.metadata.cited_evidence_references).toHaveLength(2);
  });

  it('handles guardrail intervention with empty response', async () => {
    const s3Error = new Error('NoSuchKey') as Error & { name: string };
    s3Error.name = 'NoSuchKey';
    const mockS3 = createMockS3Client(null, s3Error);
    setS3Client(mockS3);

    const mockBedrock = createMockBedrockClient('', { guardrailIntervened: true });
    setBedrockClient(mockBedrock);

    const input = buildMockInput();
    const result = await generateAppealLetter(input);

    expect(result.letter_body).toBe('');
    expect(result.guardrail_intervened).toBe(true);
    expect(result.incomplete_sections).toContain('letter_body');
    expect(result.metadata.patient_id).toBe('PAT001');
  });

  it('detects incomplete sections when evidence is empty', async () => {
    const s3Error = new Error('NoSuchKey') as Error & { name: string };
    s3Error.name = 'NoSuchKey';
    const mockS3 = createMockS3Client(null, s3Error);
    setS3Client(mockS3);

    const mockBedrock = createMockBedrockClient(buildSampleLetterResponse());
    setBedrockClient(mockBedrock);

    const input = buildMockInput({
      evidencePackage: buildMockEvidencePackage({ evidence_items: [] }),
    });
    const result = await generateAppealLetter(input);

    expect(result.incomplete_sections).toContain('clinical_justification');
  });

  it('includes all metadata fields in the result', async () => {
    const s3Error = new Error('NoSuchKey') as Error & { name: string };
    s3Error.name = 'NoSuchKey';
    const mockS3 = createMockS3Client(null, s3Error);
    setS3Client(mockS3);

    const mockBedrock = createMockBedrockClient(buildSampleLetterResponse());
    setBedrockClient(mockBedrock);

    const input = buildMockInput();
    const result = await generateAppealLetter(input);

    // Verify all required metadata fields are present
    expect(result.metadata).toHaveProperty('patient_id');
    expect(result.metadata).toHaveProperty('claim_id');
    expect(result.metadata).toHaveProperty('denial_reasons');
    expect(result.metadata).toHaveProperty('cited_evidence_references');
    expect(result.metadata).toHaveProperty('regulatory_citations');
    expect(result.metadata).toHaveProperty('appeal_arguments');
  });
});
