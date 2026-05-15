/**
 * Unit tests for Appeal Letter Parser Lambda
 *
 * Tests system-generated letter parsing (deterministic regex-based),
 * external letter parsing (Bedrock-based), unparseable input handling,
 * and per-field extraction status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseAppealLetter,
  parseSystemGeneratedLetter,
  parseExternalLetter,
  isSystemGeneratedLetter,
  extractMetadataSection,
  buildExtractionPrompt,
  invokeBedrockExtraction,
  convertBedrockResponse,
  buildFailureResult,
  detectAppealStructure,
  setBedrockClient,
  resetBedrockClient,
} from '@lambdas/parser/letter-parser';
import type { AppealData, AppealLetterMetadata } from '@shared/models';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function buildSystemGeneratedLetter(metadata: AppealLetterMetadata): string {
  const letterBody = `Dear Appeals Department,

I am writing to appeal the denial of claim ${metadata.claim_id} for patient ${metadata.patient_id}.

The claim was denied for the following reasons: ${metadata.denial_reasons.join(', ')}.

Based on the clinical evidence, we believe this denial should be overturned.

Sincerely,
Dr. Smith`;

  const metadataJson = JSON.stringify(metadata, null, 2);

  return `${letterBody}

---METADATA---
${metadataJson}
---END_METADATA---`;
}

function buildCompleteMetadata(): AppealLetterMetadata {
  return {
    patient_id: 'PAT-12345',
    claim_id: 'CLM-67890',
    denial_reasons: ['CO-50', 'CO-97'],
    cited_evidence_references: [
      {
        fhir_resource_id: 'Encounter/enc-001',
        date: '2024-03-10',
        provider: 'Dr. Jane Smith',
      },
      {
        fhir_resource_id: 'Procedure/proc-002',
        date: '2024-03-12',
        provider: 'Dr. John Doe',
      },
    ],
    regulatory_citations: [
      {
        type: 'lcd',
        reference_id: 'L35062',
        section: '4.2',
        description: 'Coverage criteria for spinal fusion procedures',
      },
    ],
    appeal_arguments: [
      'Medical necessity supported by documented progressive neurological deficit',
      'Conservative treatment exhausted over 6-month period',
    ],
  };
}

function createMockBedrockClient(responsePayload: unknown): BedrockRuntimeClient {
  const mockSend = vi.fn().mockResolvedValue({
    body: new TextEncoder().encode(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(responsePayload) }],
        stop_reason: 'end_turn',
      })
    ),
  });

  return { send: mockSend } as unknown as BedrockRuntimeClient;
}

function createMockBedrockClientWithGuardrailIntervention(): BedrockRuntimeClient {
  const mockSend = vi.fn().mockResolvedValue({
    body: new TextEncoder().encode(
      JSON.stringify({
        content: [{ type: 'text', text: '' }],
        stop_reason: 'guardrail_intervened',
        amazon_bedrock_guardrailAction: 'INTERVENED',
      })
    ),
  });

  return { send: mockSend } as unknown as BedrockRuntimeClient;
}

function createMockBedrockClientWithError(): BedrockRuntimeClient {
  const mockSend = vi.fn().mockRejectedValue(new Error('Bedrock service error'));
  return { send: mockSend } as unknown as BedrockRuntimeClient;
}

// ─── Tests: isSystemGeneratedLetter ─────────────────────────────────────────

describe('isSystemGeneratedLetter', () => {
  it('returns true when both metadata markers are present', () => {
    const input = 'Some letter content\n---METADATA---\n{}\n---END_METADATA---';
    expect(isSystemGeneratedLetter(input)).toBe(true);
  });

  it('returns false when only start marker is present', () => {
    const input = 'Some letter content\n---METADATA---\n{}';
    expect(isSystemGeneratedLetter(input)).toBe(false);
  });

  it('returns false when only end marker is present', () => {
    const input = 'Some letter content\n{}\n---END_METADATA---';
    expect(isSystemGeneratedLetter(input)).toBe(false);
  });

  it('returns false when neither marker is present', () => {
    const input = 'Just a regular letter with no metadata section.';
    expect(isSystemGeneratedLetter(input)).toBe(false);
  });
});

// ─── Tests: extractMetadataSection ──────────────────────────────────────────

describe('extractMetadataSection', () => {
  it('extracts JSON between metadata markers', () => {
    const json = '{"patient_id": "PAT001"}';
    const input = `Letter body\n---METADATA---\n${json}\n---END_METADATA---`;
    expect(extractMetadataSection(input)).toBe(json);
  });

  it('trims whitespace from extracted metadata', () => {
    const input = 'Letter body\n---METADATA---\n  {"key": "value"}  \n---END_METADATA---';
    expect(extractMetadataSection(input)).toBe('{"key": "value"}');
  });

  it('returns null when markers are missing', () => {
    expect(extractMetadataSection('no markers here')).toBeNull();
  });

  it('returns null when end marker comes before start marker', () => {
    const input = '---END_METADATA---\nsome text\n---METADATA---';
    expect(extractMetadataSection(input)).toBeNull();
  });

  it('returns null when metadata section is empty', () => {
    const input = '---METADATA---\n\n---END_METADATA---';
    expect(extractMetadataSection(input)).toBeNull();
  });
});

// ─── Tests: parseSystemGeneratedLetter ──────────────────────────────────────

describe('parseSystemGeneratedLetter', () => {
  it('parses a complete system-generated letter with all fields', () => {
    const metadata = buildCompleteMetadata();
    const letter = buildSystemGeneratedLetter(metadata);

    const result = parseSystemGeneratedLetter(letter);

    expect(result.parse_status).toBe('success');
    expect(result.original_input_preserved).toBe(false);
    expect(result.patient_id).toEqual({ value: 'PAT-12345', extracted: true, reason: null });
    expect(result.claim_id).toEqual({ value: 'CLM-67890', extracted: true, reason: null });
    expect(result.denial_reasons).toEqual({ value: ['CO-50', 'CO-97'], extracted: true, reason: null });
    expect(result.cited_evidence_references.extracted).toBe(true);
    expect(result.cited_evidence_references.value).toHaveLength(2);
    expect(result.regulatory_citations.extracted).toBe(true);
    expect(result.regulatory_citations.value).toHaveLength(1);
    expect(result.appeal_arguments).toEqual({
      value: [
        'Medical necessity supported by documented progressive neurological deficit',
        'Conservative treatment exhausted over 6-month period',
      ],
      extracted: true,
      reason: null,
    });
  });

  it('returns partial status when some fields are missing', () => {
    const partialMetadata = {
      patient_id: 'PAT-001',
      claim_id: 'CLM-001',
      // Missing denial_reasons, cited_evidence_references, regulatory_citations, appeal_arguments
    };
    const letter = `Letter body\n---METADATA---\n${JSON.stringify(partialMetadata)}\n---END_METADATA---`;

    const result = parseSystemGeneratedLetter(letter);

    expect(result.parse_status).toBe('partial');
    expect(result.patient_id.extracted).toBe(true);
    expect(result.claim_id.extracted).toBe(true);
    expect(result.denial_reasons.extracted).toBe(false);
    expect(result.appeal_arguments.extracted).toBe(false);
  });

  it('returns failure when metadata JSON is invalid', () => {
    const letter = 'Letter body\n---METADATA---\nnot valid json\n---END_METADATA---';

    const result = parseSystemGeneratedLetter(letter);

    expect(result.parse_status).toBe('failure');
    expect(result.original_input_preserved).toBe(true);
  });

  it('handles empty arrays for denial_reasons as failure', () => {
    const metadata = {
      patient_id: 'PAT-001',
      claim_id: 'CLM-001',
      denial_reasons: [],
      cited_evidence_references: [],
      regulatory_citations: [],
      appeal_arguments: [],
    };
    const letter = `Letter body\n---METADATA---\n${JSON.stringify(metadata)}\n---END_METADATA---`;

    const result = parseSystemGeneratedLetter(letter);

    // denial_reasons and appeal_arguments require non-empty arrays
    expect(result.denial_reasons.extracted).toBe(false);
    expect(result.appeal_arguments.extracted).toBe(false);
    // cited_evidence_references and regulatory_citations allow empty arrays
    expect(result.cited_evidence_references.extracted).toBe(true);
    expect(result.regulatory_citations.extracted).toBe(true);
  });

  it('filters invalid cited_evidence_references entries', () => {
    const metadata = {
      patient_id: 'PAT-001',
      claim_id: 'CLM-001',
      denial_reasons: ['CO-50'],
      cited_evidence_references: [
        { fhir_resource_id: 'Encounter/enc-001', date: '2024-01-01', provider: 'Dr. Smith' },
        { fhir_resource_id: 'invalid-no-date' }, // Missing date and provider
        'not-an-object',
      ],
      regulatory_citations: [],
      appeal_arguments: ['Argument 1'],
    };
    const letter = `Letter body\n---METADATA---\n${JSON.stringify(metadata)}\n---END_METADATA---`;

    const result = parseSystemGeneratedLetter(letter);

    expect(result.cited_evidence_references.extracted).toBe(true);
    expect(result.cited_evidence_references.value).toHaveLength(1);
    expect(result.cited_evidence_references.value![0].fhir_resource_id).toBe('Encounter/enc-001');
  });

  it('filters invalid regulatory_citations entries', () => {
    const metadata = {
      patient_id: 'PAT-001',
      claim_id: 'CLM-001',
      denial_reasons: ['CO-50'],
      cited_evidence_references: [],
      regulatory_citations: [
        { type: 'lcd', reference_id: 'L35062', section: '4.2', description: 'Valid citation' },
        { type: 'invalid_type', reference_id: 'X', section: '1', description: 'Bad type' },
        { type: 'ncd' }, // Missing fields
      ],
      appeal_arguments: ['Argument 1'],
    };
    const letter = `Letter body\n---METADATA---\n${JSON.stringify(metadata)}\n---END_METADATA---`;

    const result = parseSystemGeneratedLetter(letter);

    expect(result.regulatory_citations.extracted).toBe(true);
    expect(result.regulatory_citations.value).toHaveLength(1);
    expect(result.regulatory_citations.value![0].reference_id).toBe('L35062');
  });
});

// ─── Tests: Round-trip integrity ────────────────────────────────────────────

describe('round-trip integrity', () => {
  it('parsing a system-generated letter produces identical field values', () => {
    const originalMetadata = buildCompleteMetadata();
    const letter = buildSystemGeneratedLetter(originalMetadata);

    const result = parseSystemGeneratedLetter(letter);

    expect(result.parse_status).toBe('success');
    expect(result.patient_id.value).toBe(originalMetadata.patient_id);
    expect(result.claim_id.value).toBe(originalMetadata.claim_id);
    expect(result.denial_reasons.value).toEqual(originalMetadata.denial_reasons);
    expect(result.cited_evidence_references.value).toEqual(originalMetadata.cited_evidence_references);
    expect(result.regulatory_citations.value).toEqual(originalMetadata.regulatory_citations);
    expect(result.appeal_arguments.value).toEqual(originalMetadata.appeal_arguments);
  });

  it('round-trip works with special characters in fields', () => {
    const metadata: AppealLetterMetadata = {
      patient_id: 'PAT-"special"',
      claim_id: 'CLM/with\\slashes',
      denial_reasons: ['Reason with "quotes"', 'Reason with\nnewline'],
      cited_evidence_references: [
        { fhir_resource_id: 'Encounter/enc-001', date: '2024-01-01', provider: "Dr. O'Brien" },
      ],
      regulatory_citations: [
        { type: 'lcd', reference_id: 'L-123', section: '§4.2(a)', description: 'Description with <html>' },
      ],
      appeal_arguments: ['Argument with "double quotes" and \'single quotes\''],
    };
    const letter = buildSystemGeneratedLetter(metadata);

    const result = parseSystemGeneratedLetter(letter);

    expect(result.parse_status).toBe('success');
    expect(result.patient_id.value).toBe(metadata.patient_id);
    expect(result.claim_id.value).toBe(metadata.claim_id);
    expect(result.denial_reasons.value).toEqual(metadata.denial_reasons);
    expect(result.cited_evidence_references.value).toEqual(metadata.cited_evidence_references);
    expect(result.regulatory_citations.value).toEqual(metadata.regulatory_citations);
    expect(result.appeal_arguments.value).toEqual(metadata.appeal_arguments);
  });
});

// ─── Tests: External letter parsing (Bedrock-based) ─────────────────────────

describe('parseExternalLetter', () => {
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

  it('extracts all fields from a well-structured external letter', async () => {
    const bedrockResponse = {
      patient_id: { value: 'PAT-999', found: true, reason: null },
      claim_id: { value: 'CLM-888', found: true, reason: null },
      denial_reasons: { value: ['CO-50', 'CO-97'], found: true, reason: null },
      cited_evidence_references: {
        value: [{ fhir_resource_id: 'Encounter/e1', date: '2024-01-01', provider: 'Dr. A' }],
        found: true,
        reason: null,
      },
      regulatory_citations: {
        value: [{ type: 'lcd', reference_id: 'L100', section: '3.1', description: 'Coverage policy' }],
        found: true,
        reason: null,
      },
      appeal_arguments: { value: ['Medical necessity established'], found: true, reason: null },
    };

    const mockClient = createMockBedrockClient(bedrockResponse);
    setBedrockClient(mockClient);

    const letterText = `Dear Appeals Department,
I am writing to appeal the denial of claim CLM-888 for patient PAT-999.
The claim was denied as not medically necessary.
Sincerely, Dr. Smith`;

    const result = await parseExternalLetter(letterText);

    expect(result.parse_status).toBe('success');
    expect(result.patient_id).toEqual({ value: 'PAT-999', extracted: true, reason: null });
    expect(result.claim_id).toEqual({ value: 'CLM-888', extracted: true, reason: null });
    expect(result.denial_reasons).toEqual({ value: ['CO-50', 'CO-97'], extracted: true, reason: null });
  });

  it('returns partial status when some fields cannot be extracted', async () => {
    const bedrockResponse = {
      patient_id: { value: 'PAT-999', found: true, reason: null },
      claim_id: { value: 'CLM-888', found: true, reason: null },
      denial_reasons: { value: null, found: false, reason: 'No explicit denial reasons found' },
      cited_evidence_references: { value: null, found: false, reason: 'No FHIR references found' },
      regulatory_citations: { value: null, found: false, reason: 'No regulatory citations found' },
      appeal_arguments: { value: ['General appeal for reconsideration'], found: true, reason: null },
    };

    const mockClient = createMockBedrockClient(bedrockResponse);
    setBedrockClient(mockClient);

    const letterText = `Dear Appeals Department,
I am writing to appeal the denial of claim CLM-888 for patient PAT-999.
Please reconsider this denial.
Sincerely, Dr. Smith`;

    const result = await parseExternalLetter(letterText);

    expect(result.parse_status).toBe('partial');
    expect(result.patient_id.extracted).toBe(true);
    expect(result.claim_id.extracted).toBe(true);
    expect(result.denial_reasons.extracted).toBe(false);
    expect(result.denial_reasons.reason).toBe('No explicit denial reasons found');
  });

  it('returns failure when Bedrock guardrail intervenes', async () => {
    const mockClient = createMockBedrockClientWithGuardrailIntervention();
    setBedrockClient(mockClient);

    const letterText = `Dear Appeals Department,
I am writing to appeal the denial of claim CLM-001.
The patient requires this treatment.
Sincerely, Dr. Smith`;

    const result = await parseExternalLetter(letterText);

    expect(result.parse_status).toBe('failure');
    expect(result.original_input_preserved).toBe(true);
  });

  it('returns failure when Bedrock throws an error', async () => {
    const mockClient = createMockBedrockClientWithError();
    setBedrockClient(mockClient);

    const letterText = `Dear Appeals Department,
I am writing to appeal the denial of claim CLM-001.
The patient requires this treatment.
Sincerely, Dr. Smith`;

    const result = await parseExternalLetter(letterText);

    expect(result.parse_status).toBe('failure');
    expect(result.original_input_preserved).toBe(true);
  });
});

// ─── Tests: convertBedrockResponse ──────────────────────────────────────────

describe('convertBedrockResponse', () => {
  it('converts a fully successful response', () => {
    const response = {
      patient_id: { value: 'PAT-001', found: true, reason: null },
      claim_id: { value: 'CLM-001', found: true, reason: null },
      denial_reasons: { value: ['CO-50'], found: true, reason: null },
      cited_evidence_references: {
        value: [{ fhir_resource_id: 'Enc/1', date: '2024-01-01', provider: 'Dr. A' }],
        found: true,
        reason: null,
      },
      regulatory_citations: {
        value: [{ type: 'ncd', reference_id: 'N100', section: '1.0', description: 'Policy' }],
        found: true,
        reason: null,
      },
      appeal_arguments: { value: ['Argument 1'], found: true, reason: null },
    };

    const result = convertBedrockResponse(response);

    expect(result.parse_status).toBe('success');
    expect(result.patient_id.extracted).toBe(true);
    expect(result.claim_id.extracted).toBe(true);
  });

  it('handles missing fields in response gracefully', () => {
    const response = {
      patient_id: { value: 'PAT-001', found: true, reason: null },
      // All other fields missing from response
    };

    const result = convertBedrockResponse(response);

    expect(result.parse_status).toBe('partial');
    expect(result.patient_id.extracted).toBe(true);
    expect(result.claim_id.extracted).toBe(false);
    expect(result.denial_reasons.extracted).toBe(false);
  });
});

// ─── Tests: detectAppealStructure ───────────────────────────────────────────

describe('detectAppealStructure', () => {
  it('returns true for text with multiple appeal indicators', () => {
    const text = 'I am writing to appeal the denial of this claim for the patient.';
    expect(detectAppealStructure(text)).toBe(true);
  });

  it('returns false for random text with no appeal indicators', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    expect(detectAppealStructure(text)).toBe(false);
  });

  it('returns false for text with only one indicator', () => {
    const text = 'This is about a claim that was processed.';
    expect(detectAppealStructure(text)).toBe(false);
  });

  it('is case-insensitive', () => {
    const text = 'APPEAL of DENIAL for CLAIM submitted.';
    expect(detectAppealStructure(text)).toBe(true);
  });
});

// ─── Tests: buildFailureResult ──────────────────────────────────────────────

describe('buildFailureResult', () => {
  it('returns failure status with all fields marked as not extracted', () => {
    const result = buildFailureResult();

    expect(result.parse_status).toBe('failure');
    expect(result.original_input_preserved).toBe(true);
    expect(result.patient_id.extracted).toBe(false);
    expect(result.claim_id.extracted).toBe(false);
    expect(result.denial_reasons.extracted).toBe(false);
    expect(result.cited_evidence_references.extracted).toBe(false);
    expect(result.regulatory_citations.extracted).toBe(false);
    expect(result.appeal_arguments.extracted).toBe(false);
  });

  it('includes reason for each failed field', () => {
    const result = buildFailureResult();

    expect(result.patient_id.reason).toContain('unparseable');
    expect(result.claim_id.reason).toContain('unparseable');
  });
});

// ─── Tests: parseAppealLetter (main entry point) ────────────────────────────

describe('parseAppealLetter', () => {
  afterEach(() => {
    resetBedrockClient();
  });

  it('returns failure for empty input', async () => {
    const result = await parseAppealLetter('');
    expect(result.parse_status).toBe('failure');
    expect(result.original_input_preserved).toBe(true);
  });

  it('returns failure for whitespace-only input', async () => {
    const result = await parseAppealLetter('   \n\t  ');
    expect(result.parse_status).toBe('failure');
    expect(result.original_input_preserved).toBe(true);
  });

  it('routes to system-generated parser when metadata markers present', async () => {
    const metadata = buildCompleteMetadata();
    const letter = buildSystemGeneratedLetter(metadata);

    const result = await parseAppealLetter(letter);

    expect(result.parse_status).toBe('success');
    expect(result.patient_id.value).toBe(metadata.patient_id);
  });

  it('routes to external parser when no metadata markers present', async () => {
    const bedrockResponse = {
      patient_id: { value: 'PAT-EXT', found: true, reason: null },
      claim_id: { value: 'CLM-EXT', found: true, reason: null },
      denial_reasons: { value: ['CO-50'], found: true, reason: null },
      cited_evidence_references: { value: [], found: true, reason: null },
      regulatory_citations: { value: [], found: true, reason: null },
      appeal_arguments: { value: ['Reconsider this denial'], found: true, reason: null },
    };

    const mockClient = createMockBedrockClient(bedrockResponse);
    setBedrockClient(mockClient);

    const letterText = `Dear Appeals Department,
I am writing to appeal the denial of claim CLM-EXT for patient PAT-EXT.
The claim was denied but should be reconsidered.
Sincerely, Dr. Smith`;

    const result = await parseAppealLetter(letterText);

    expect(result.patient_id.value).toBe('PAT-EXT');
    expect(result.claim_id.value).toBe('CLM-EXT');
  });

  it('returns failure for input with no appeal structure and no metadata', async () => {
    const result = await parseAppealLetter('This is just random text about cooking recipes.');
    expect(result.parse_status).toBe('failure');
    expect(result.original_input_preserved).toBe(true);
  });
});

// ─── Tests: buildExtractionPrompt ───────────────────────────────────────────

describe('buildExtractionPrompt', () => {
  it('includes the letter text in the prompt', () => {
    const letterText = 'Dear Appeals Department, I am writing about claim CLM-001.';
    const prompt = buildExtractionPrompt(letterText);

    expect(prompt).toContain(letterText);
    expect(prompt).toContain('---LETTER START---');
    expect(prompt).toContain('---LETTER END---');
  });

  it('includes extraction instructions for all required fields', () => {
    const prompt = buildExtractionPrompt('Some letter text');

    expect(prompt).toContain('patient_id');
    expect(prompt).toContain('claim_id');
    expect(prompt).toContain('denial_reasons');
    expect(prompt).toContain('cited_evidence_references');
    expect(prompt).toContain('regulatory_citations');
    expect(prompt).toContain('appeal_arguments');
  });

  it('instructs not to fabricate values', () => {
    const prompt = buildExtractionPrompt('Some letter text');
    expect(prompt).toContain('Do NOT infer or fabricate');
  });
});
