/**
 * Unit tests for Evidence Retrieval Handler
 *
 * Tests the orchestration of HealthLake query → entity extraction → scoring → filtering,
 * DynamoDB storage, SNS notifications for manual review, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  setClients,
  resetClients,
  extractTextFromFhirResource,
  convertToFhirResourceInputs,
  type EvidenceHandlerInput,
} from '@lambdas/evidence/handler';
import type { ClassifiedDenial, DenialRecord, EvidencePackage } from '@shared/models';
import type { FhirResource } from '@lambdas/evidence/healthlake-query';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@lambdas/evidence/healthlake-query', () => ({
  queryHealthLake: vi.fn(),
}));

vi.mock('@lambdas/evidence/entity-extractor', () => ({
  extractAndScoreEvidence: vi.fn(),
}));

import { queryHealthLake } from '@lambdas/evidence/healthlake-query';
import { extractAndScoreEvidence } from '@lambdas/evidence/entity-extractor';

const mockQueryHealthLake = vi.mocked(queryHealthLake);
const mockExtractAndScoreEvidence = vi.mocked(extractAndScoreEvidence);

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
    denied_amount: 1500.00,
    raw_denial_reason_text: 'CO-50: Not deemed medically necessary',
    source_format: 'edi_835',
    source_s3_key: 's3://bucket/file.edi',
    ingestion_timestamp: '2024-01-15T10:00:00Z',
    status: 'classified',
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
        dollar_amount: 1500,
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

function createMockHandlerInput(overrides: Partial<EvidenceHandlerInput> = {}): EvidenceHandlerInput {
  return {
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

function createMockSnsClient() {
  return {
    send: vi.fn().mockResolvedValue({ MessageId: 'msg-123' }),
  } as any;
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetClients();
  process.env.TABLE_NAME = 'TestTable';
  process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
  process.env.HEALTHLAKE_ENDPOINT = 'https://healthlake.us-east-1.amazonaws.com';
  process.env.HEALTHLAKE_DATASTORE_ID = 'ds-12345';
});

afterEach(() => {
  resetClients();
  delete process.env.TABLE_NAME;
  delete process.env.SNS_TOPIC_ARN;
  delete process.env.HEALTHLAKE_ENDPOINT;
  delete process.env.HEALTHLAKE_DATASTORE_ID;
});

// ─── extractTextFromFhirResource Tests ──────────────────────────────────────

describe('extractTextFromFhirResource', () => {
  it('should extract text from text.div field', () => {
    const resource: FhirResource = {
      resourceType: 'Condition',
      id: 'cond-1',
      text: { div: '<div>Patient has type 2 diabetes mellitus</div>' },
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('Patient has type 2 diabetes mellitus');
  });

  it('should extract text from note[].text field', () => {
    const resource: FhirResource = {
      resourceType: 'DiagnosticReport',
      id: 'dr-1',
      note: [
        { text: 'Lab results indicate elevated HbA1c' },
        { text: 'Follow-up recommended in 3 months' },
      ],
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toContain('Lab results indicate elevated HbA1c');
    expect(result).toContain('Follow-up recommended in 3 months');
  });

  it('should extract text from code.text field for Procedure', () => {
    const resource: FhirResource = {
      resourceType: 'Procedure',
      id: 'proc-1',
      code: { text: 'Total knee arthroplasty' },
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('Total knee arthroplasty');
  });

  it('should extract text from code.text field for Condition', () => {
    const resource: FhirResource = {
      resourceType: 'Condition',
      id: 'cond-4',
      code: { text: 'Type 2 diabetes mellitus' },
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('Type 2 diabetes mellitus');
  });

  it('should extract text from reasonCode[0].text for Encounter', () => {
    const resource: FhirResource = {
      resourceType: 'Encounter',
      id: 'enc-2',
      reasonCode: [{ text: 'Knee pain evaluation' }],
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('Knee pain evaluation');
  });

  it('should extract text from conclusion for DiagnosticReport', () => {
    const resource: FhirResource = {
      resourceType: 'DiagnosticReport',
      id: 'dr-2',
      conclusion: 'HbA1c elevated at 8.2%, consistent with poorly controlled diabetes',
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('HbA1c elevated at 8.2%, consistent with poorly controlled diabetes');
  });

  it('should extract text from description for DocumentReference', () => {
    const resource: FhirResource = {
      resourceType: 'DocumentReference',
      id: 'doc-1',
      description: 'Operative note for left knee replacement',
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('Operative note for left knee replacement');
  });

  it('should decode base64 content[0].attachment.data for DocumentReference', () => {
    const encodedText = Buffer.from('Patient underwent successful knee replacement surgery').toString('base64');
    const resource: FhirResource = {
      resourceType: 'DocumentReference',
      id: 'doc-2',
      content: [{ attachment: { data: encodedText, contentType: 'text/plain' } }],
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('Patient underwent successful knee replacement surgery');
  });

  it('should concatenate description and base64 content for DocumentReference', () => {
    const encodedText = Buffer.from('Detailed surgical notes').toString('base64');
    const resource: FhirResource = {
      resourceType: 'DocumentReference',
      id: 'doc-3',
      description: 'Operative note',
      content: [{ attachment: { data: encodedText } }],
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toContain('Operative note');
    expect(result).toContain('Detailed surgical notes');
  });

  it('should concatenate text.div and reasonCode for Encounter', () => {
    const resource: FhirResource = {
      resourceType: 'Encounter',
      id: 'enc-1',
      text: { div: '<div>Office visit</div>' },
      note: [{ text: 'Patient presents with knee pain' }],
      reasonCode: [{ text: 'Knee pain evaluation' }],
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toContain('Office visit');
    expect(result).toContain('Knee pain evaluation');
    expect(result).toContain('Patient presents with knee pain');
  });

  it('should return empty string when no text fields are present', () => {
    const resource: FhirResource = {
      resourceType: 'Condition',
      id: 'cond-2',
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).toBe('');
  });

  it('should strip HTML tags from text.div', () => {
    const resource: FhirResource = {
      resourceType: 'Condition',
      id: 'cond-3',
      text: { div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>Diagnosis: <b>Hypertension</b></p></div>' },
    };

    const result = extractTextFromFhirResource(resource);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('Diagnosis');
    expect(result).toContain('Hypertension');
  });
});

// ─── convertToFhirResourceInputs Tests ──────────────────────────────────────

describe('convertToFhirResourceInputs', () => {
  it('should convert FHIR resources to FhirResourceInput format', () => {
    const resources: FhirResource[] = [
      {
        resourceType: 'Condition',
        id: 'cond-1',
        recordedDate: '2024-01-10',
        recorder: { display: 'Dr. Smith' },
        text: { div: '<div>Type 2 diabetes</div>' },
      },
    ];

    const result = convertToFhirResourceInputs(resources);

    expect(result).toHaveLength(1);
    expect(result[0].fhir_resource_id).toBe('cond-1');
    expect(result[0].fhir_resource_type).toBe('Condition');
    expect(result[0].date).toBe('2024-01-10');
    expect(result[0].authoring_provider).toBe('Dr. Smith');
    expect(result[0].text_content).toContain('Type 2 diabetes');
  });

  it('should extract provider from performer field', () => {
    const resources: FhirResource[] = [
      {
        resourceType: 'Procedure',
        id: 'proc-1',
        date: '2024-01-12',
        performer: [{ display: 'Dr. Johnson' }],
        code: { text: 'Knee surgery' },
      },
    ];

    const result = convertToFhirResourceInputs(resources);
    expect(result[0].authoring_provider).toBe('Dr. Johnson');
  });

  it('should use "Unknown" when no provider is found', () => {
    const resources: FhirResource[] = [
      {
        resourceType: 'Condition',
        id: 'cond-2',
        recordedDate: '2024-01-10',
        text: { div: '<div>Some condition</div>' },
      },
    ];

    const result = convertToFhirResourceInputs(resources);
    expect(result[0].authoring_provider).toBe('Unknown');
  });
});

// ─── Handler: Successful Evidence Retrieval ─────────────────────────────────

describe('handler - successful evidence retrieval', () => {
  it('should orchestrate HealthLake query → extraction → scoring → storage', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [
        {
          resourceType: 'Condition',
          id: 'cond-1',
          meta: { lastUpdated: '2024-01-10T08:00:00Z' },
          recordedDate: '2024-01-10',
          recorder: { display: 'Dr. Smith' },
          text: { div: '<div>Type 2 diabetes mellitus</div>' },
        },
      ],
      totalRetrieved: 1,
      returnedCount: 1,
      capped: false,
      durationMs: 2500,
      timedOut: false,
      queriedResourceTypes: ['Condition'],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
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
      ],
      manual_review_required: false,
    });

    const result = await handler(input);

    // Verify HealthLake was queried with correct params
    expect(mockQueryHealthLake).toHaveBeenCalledWith({
      patientId: 'PAT001',
      dateOfService: '2024-01-15',
    });

    // Verify entity extraction was called with converted resources
    expect(mockExtractAndScoreEvidence).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          fhir_resource_id: 'cond-1',
          fhir_resource_type: 'Condition',
          text_content: expect.stringContaining('Type 2 diabetes mellitus'),
        }),
      ]),
      {
        carc_codes: input.classifiedDenial.carc_codes,
        raw_denial_reason_text: 'CO-50: Not deemed medically necessary',
      }
    );

    // Verify result
    expect(result.evidencePackage.claim_id).toBe('CLM001');
    expect(result.evidencePackage.patient_id).toBe('PAT001');
    expect(result.evidencePackage.evidence_items).toHaveLength(1);
    expect(result.evidencePackage.total_evidence_count).toBe(1);
    expect(result.evidencePackage.manual_review_required).toBe(false);
    expect(result.manualReviewRequired).toBe(false);
    expect(result.timedOut).toBe(false);

    // Verify DynamoDB storage
    expect(mockDynamo.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: 'TestTable',
          Item: expect.objectContaining({
            PK: 'TENANT#tenant-1',
            SK: 'EVIDENCE#CLM001',
            claim_id: 'CLM001',
            patient_id: 'PAT001',
          }),
        }),
      })
    );

    // Verify no SNS notification sent (no manual review needed)
    expect(mockSns.send).not.toHaveBeenCalled();
  });

  it('should set correct PK/SK on the evidence package', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput({
      denialRecord: createMockDenialRecord({ tenant_id: 'my-org', claim_id: 'CLM-999' }),
      classifiedDenial: createMockClassifiedDenial({ claim_id: 'CLM-999' }),
    });

    mockQueryHealthLake.mockResolvedValue({
      resources: [],
      totalRetrieved: 0,
      returnedCount: 0,
      capped: false,
      durationMs: 500,
      timedOut: false,
      queriedResourceTypes: ['Encounter', 'Procedure', 'Condition', 'DiagnosticReport', 'DocumentReference'],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [],
      manual_review_required: false,
    });

    const result = await handler(input);

    expect(result.evidencePackage.PK).toBe('TENANT#my-org');
    expect(result.evidencePackage.SK).toBe('EVIDENCE#CLM-999');
  });
});

// ─── Handler: Manual Review - No Evidence Found ─────────────────────────────

describe('handler - manual review when no evidence found', () => {
  it('should flag for manual review and send SNS when no evidence found', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [],
      totalRetrieved: 0,
      returnedCount: 0,
      capped: false,
      durationMs: 1200,
      timedOut: false,
      queriedResourceTypes: ['Encounter', 'Procedure', 'Condition', 'DiagnosticReport', 'DocumentReference'],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [],
      manual_review_required: false,
    });

    const result = await handler(input);

    expect(result.manualReviewRequired).toBe(true);
    expect(result.evidencePackage.manual_review_required).toBe(true);

    // Verify SNS notification was sent
    expect(mockSns.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TopicArn: 'arn:aws:sns:us-east-1:123456789:test-topic',
          Subject: '[Denial Appeal] Manual Review Required - Claim CLM001',
          Message: expect.stringContaining('No matching clinical evidence found'),
          MessageAttributes: expect.objectContaining({
            event_type: {
              DataType: 'String',
              StringValue: 'MANUAL_REVIEW_REQUIRED',
            },
            tenant_id: {
              DataType: 'String',
              StringValue: 'tenant-1',
            },
          }),
        }),
      })
    );
  });
});

// ─── Handler: Manual Review - Timeout ───────────────────────────────────────

describe('handler - manual review on timeout', () => {
  it('should flag for manual review and send SNS when HealthLake times out', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [
        {
          resourceType: 'Encounter',
          id: 'enc-1',
          meta: { lastUpdated: '2024-01-14T09:00:00Z' },
          date: '2024-01-14',
          participant: [{ individual: { display: 'Dr. Jones' } }],
          text: { div: '<div>Office visit for knee pain</div>' },
        },
      ],
      totalRetrieved: 1,
      returnedCount: 1,
      capped: false,
      durationMs: 60000,
      timedOut: true,
      queriedResourceTypes: ['Encounter'],
      failedResourceTypes: ['Procedure', 'Condition', 'DiagnosticReport', 'DocumentReference'],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [
        {
          fhir_resource_id: 'enc-1',
          fhir_resource_type: 'Encounter',
          date: '2024-01-14',
          authoring_provider: 'Dr. Jones',
          relevance_score: 0.5,
          extracted_entities: [],
          mapped_denial_reasons: ['CO-50'],
        },
      ],
      manual_review_required: false,
    });

    const result = await handler(input);

    expect(result.manualReviewRequired).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.evidencePackage.manual_review_required).toBe(true);
    // Still has partial evidence
    expect(result.evidencePackage.evidence_items).toHaveLength(1);

    // Verify SNS notification mentions timeout
    expect(mockSns.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Message: expect.stringContaining('HealthLake query timed out'),
        }),
      })
    );
  });
});

// ─── Handler: Manual Review - Comprehend Failure ────────────────────────────

describe('handler - manual review on Comprehend failure', () => {
  it('should flag for manual review when entity extraction fails', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [
        {
          resourceType: 'DiagnosticReport',
          id: 'dr-1',
          meta: { lastUpdated: '2024-01-12T14:00:00Z' },
          date: '2024-01-12',
          performer: [{ display: 'Lab Corp' }],
          text: { div: '<div>Blood work results</div>' },
        },
      ],
      totalRetrieved: 1,
      returnedCount: 1,
      capped: false,
      durationMs: 3000,
      timedOut: false,
      queriedResourceTypes: ['DiagnosticReport'],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [
        {
          fhir_resource_id: 'dr-1',
          fhir_resource_type: 'DiagnosticReport',
          date: '2024-01-12',
          authoring_provider: 'Lab Corp',
          relevance_score: 0.0,
          extracted_entities: [],
          mapped_denial_reasons: [],
        },
      ],
      manual_review_required: true,
    });

    const result = await handler(input);

    expect(result.manualReviewRequired).toBe(true);
    expect(result.evidencePackage.manual_review_required).toBe(true);

    // Verify SNS notification mentions Comprehend failure
    expect(mockSns.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Message: expect.stringContaining('Comprehend Medical entity extraction failed'),
        }),
      })
    );
  });
});

// ─── Handler: SNS Notification Handling ─────────────────────────────────────

describe('handler - SNS notification handling', () => {
  it('should not fail if SNS notification fails', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = {
      send: vi.fn().mockRejectedValue(new Error('SNS publish failed')),
    } as any;
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [],
      totalRetrieved: 0,
      returnedCount: 0,
      capped: false,
      durationMs: 500,
      timedOut: false,
      queriedResourceTypes: ['Encounter', 'Procedure', 'Condition', 'DiagnosticReport', 'DocumentReference'],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [],
      manual_review_required: false,
    });

    // Should not throw even though SNS fails
    const result = await handler(input);

    expect(result.manualReviewRequired).toBe(true);
    expect(result.evidencePackage.manual_review_required).toBe(true);
  });

  it('should skip SNS notification when topic ARN is not configured', async () => {
    delete process.env.SNS_TOPIC_ARN;

    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [],
      totalRetrieved: 0,
      returnedCount: 0,
      capped: false,
      durationMs: 500,
      timedOut: false,
      queriedResourceTypes: [],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [],
      manual_review_required: false,
    });

    await handler(input);

    expect(mockSns.send).not.toHaveBeenCalled();
  });
});

// ─── Handler: Error Handling ────────────────────────────────────────────────

describe('handler - error handling', () => {
  it('should propagate HealthLake query errors', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockRejectedValue(new Error('HealthLake connection failed'));

    await expect(handler(input)).rejects.toThrow('HealthLake connection failed');
  });

  it('should propagate entity extraction errors', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [
        {
          resourceType: 'Condition',
          id: 'cond-1',
          meta: { lastUpdated: '2024-01-10T08:00:00Z' },
          text: { div: '<div>Some condition</div>' },
        },
      ],
      totalRetrieved: 1,
      returnedCount: 1,
      capped: false,
      durationMs: 1000,
      timedOut: false,
      queriedResourceTypes: ['Condition'],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockRejectedValue(new Error('Comprehend service unavailable'));

    await expect(handler(input)).rejects.toThrow('Comprehend service unavailable');
  });

  it('should propagate DynamoDB storage errors', async () => {
    const mockDynamo = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB write failed')),
    } as any;
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [],
      totalRetrieved: 0,
      returnedCount: 0,
      capped: false,
      durationMs: 500,
      timedOut: false,
      queriedResourceTypes: [],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [],
      manual_review_required: false,
    });

    await expect(handler(input)).rejects.toThrow('DynamoDB write failed');
  });
});

// ─── Handler: Retrieval Duration Tracking ───────────────────────────────────

describe('handler - retrieval duration tracking', () => {
  it('should record retrieval_duration_ms in the evidence package', async () => {
    const mockDynamo = createMockDynamoClient();
    const mockSns = createMockSnsClient();
    setClients({ dynamo: mockDynamo, sns: mockSns });

    const input = createMockHandlerInput();

    mockQueryHealthLake.mockResolvedValue({
      resources: [],
      totalRetrieved: 0,
      returnedCount: 0,
      capped: false,
      durationMs: 500,
      timedOut: false,
      queriedResourceTypes: [],
      failedResourceTypes: [],
    });

    mockExtractAndScoreEvidence.mockResolvedValue({
      evidence_items: [],
      manual_review_required: false,
    });

    const result = await handler(input);

    expect(result.evidencePackage.retrieval_duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.evidencePackage.retrieval_timestamp).toBeDefined();
    // Verify timestamp is a valid ISO 8601 string
    const timestamp = new Date(result.evidencePackage.retrieval_timestamp);
    expect(timestamp.getTime()).not.toBeNaN();
  });
});
