import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  setClients,
  resetClients,
  type GeneratorHandlerInput,
  type GeneratorHandlerResult,
} from '@lambdas/generator/handler';
import type {
  ViabilityAssessment,
  EvidencePackage,
  ClassifiedDenial,
  DenialRecord,
  EvidenceItem,
} from '@shared/models';

// ─── Mock letter-generator module ───────────────────────────────────────────

const mockGenerateAppealLetter = vi.fn();
vi.mock('@lambdas/generator/letter-generator', () => ({
  generateAppealLetter: (...args: unknown[]) => mockGenerateAppealLetter(...args),
}));

// ─── Mock citation-validator module ─────────────────────────────────────────

const mockLookupRegulatoryReferences = vi.fn();
const mockValidateCitations = vi.fn();
const mockStripHallucinatedContent = vi.fn();
vi.mock('@lambdas/generator/citation-validator', () => ({
  lookupRegulatoryReferences: (...args: unknown[]) => mockLookupRegulatoryReferences(...args),
  validateCitations: (...args: unknown[]) => mockValidateCitations(...args),
  stripHallucinatedContent: (...args: unknown[]) => mockStripHallucinatedContent(...args),
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeEvidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    fhir_resource_id: overrides.fhir_resource_id ?? 'fhir-001',
    fhir_resource_type: overrides.fhir_resource_type ?? 'Encounter',
    date: overrides.date ?? '2024-01-15',
    authoring_provider: overrides.authoring_provider ?? 'Dr. Smith',
    relevance_score: overrides.relevance_score ?? 0.8,
    extracted_entities: overrides.extracted_entities ?? [],
    mapped_denial_reasons: overrides.mapped_denial_reasons ?? ['CO-50'],
  };
}

function makeDenialRecord(overrides: Partial<DenialRecord> = {}): DenialRecord {
  return {
    PK: 'TENANT#tenant-001',
    SK: 'DENIAL#claim-001#pdf',
    claim_id: 'claim-001',
    patient_id: 'patient-001',
    payer_id: 'medicare-partb',
    tenant_id: 'tenant-001',
    denial_date: '2024-01-10T00:00:00Z',
    denied_amount: 5000.00,
    raw_denial_reason_text: 'Medical necessity not established',
    source_format: 'pdf',
    source_s3_key: 'uploads/tenant-001/claim-001.pdf',
    ingestion_timestamp: '2024-01-20T10:00:00Z',
    status: 'assessed',
    workflow_execution_id: 'exec-001',
    ttl: 1800000000,
    ...overrides,
  };
}

function makeClassifiedDenial(overrides: Partial<ClassifiedDenial> = {}): ClassifiedDenial {
  return {
    PK: 'TENANT#tenant-001',
    SK: 'CLASSIFICATION#claim-001',
    claim_id: 'claim-001',
    carc_codes: [
      {
        code: 'CO-50',
        description: 'Medical necessity not established',
        confidence: 0.95,
        dollar_amount: 5000.00,
        rank: 1,
        required_evidence_categories: ['clinical_notes', 'procedure_records'],
      },
    ],
    rarc_codes: [
      {
        code: 'N386',
        description: 'Documentation does not support medical necessity',
        confidence: 0.90,
      },
    ],
    classification_method: 'bedrock_nlp',
    dollar_ranking_available: true,
    review_status: 'auto_classified',
    classified_at: '2024-01-20T10:05:00Z',
    ...overrides,
  };
}

function makeEvidencePackage(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    PK: 'TENANT#tenant-001',
    SK: 'EVIDENCE#claim-001',
    claim_id: 'claim-001',
    patient_id: 'patient-001',
    evidence_items: [
      makeEvidenceItem({ fhir_resource_id: 'fhir-001' }),
      makeEvidenceItem({ fhir_resource_id: 'cond-002' }),
    ],
    total_evidence_count: 2,
    retrieval_timestamp: '2024-01-20T10:10:00Z',
    retrieval_duration_ms: 2500,
    manual_review_required: false,
    ...overrides,
  };
}

function makeViabilityAssessment(overrides: Partial<ViabilityAssessment> = {}): ViabilityAssessment {
  return {
    PK: 'TENANT#tenant-001',
    SK: 'VIABILITY#claim-001',
    claim_id: 'claim-001',
    viability_score: 0.72,
    confidence_interval: { lower: 0.55, upper: 0.85, confidence_level: 0.90 },
    recommendation: 'pursue',
    rationale: [
      { factor: 'Strong clinical evidence', impact: 'positive', weight: 0.4 },
      { factor: 'High historical overturn rate', impact: 'positive', weight: 0.3 },
    ],
    top_evidence_items: ['fhir-001', 'cond-002'],
    inputs: {
      denial_reason_code: 'CO-50',
      payer_id: 'medicare-partb',
      historical_overturn_rate: 0.65,
      evidence_score: 0.8,
      claim_amount: 5000.00,
      days_to_deadline: 45,
    },
    limited_historical_data: false,
    deadline_expired: false,
    assessed_at: '2024-01-20T10:15:00Z',
    ...overrides,
  };
}

function makeHandlerInput(overrides: Partial<GeneratorHandlerInput> = {}): GeneratorHandlerInput {
  return {
    viabilityAssessment: makeViabilityAssessment(),
    evidencePackage: makeEvidencePackage(),
    classifiedDenial: makeClassifiedDenial(),
    denialRecord: makeDenialRecord(),
    ...overrides,
  };
}

// ─── Mock Clients ───────────────────────────────────────────────────────────

function makeMockDynamoClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeMockS3Client() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeMockSnsClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as any;
}

// ─── Test Setup ─────────────────────────────────────────────────────────────

describe('Generator Handler', () => {
  let mockDynamo: ReturnType<typeof makeMockDynamoClient>;
  let mockS3: ReturnType<typeof makeMockS3Client>;
  let mockSns: ReturnType<typeof makeMockSnsClient>;

  beforeEach(() => {
    mockDynamo = makeMockDynamoClient();
    mockS3 = makeMockS3Client();
    mockSns = makeMockSnsClient();

    setClients({ dynamo: mockDynamo, s3: mockS3, sns: mockSns });

    process.env.TABLE_NAME = 'DenialAppeals';
    process.env.LETTERS_BUCKET = 'appeal-letters-bucket';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:notifications';

    // Default mock implementations
    mockLookupRegulatoryReferences.mockResolvedValue([
      {
        type: 'lcd',
        reference_id: 'LCD-33345',
        section: '§4.2',
        description: 'Local Coverage Determination for procedure',
      },
    ]);

    mockGenerateAppealLetter.mockResolvedValue({
      letter_body: 'Dear Appeals Department,\n\nWe are writing to appeal the denial of claim claim-001 for patient patient-001. Evidence fhir-001 and cond-002 support medical necessity.\n\nSincerely,\nProvider',
      metadata: {
        patient_id: 'patient-001',
        claim_id: 'claim-001',
        denial_reasons: ['CO-50'],
        cited_evidence_references: [
          { fhir_resource_id: 'fhir-001', date: '2024-01-15', provider: 'Dr. Smith' },
        ],
        regulatory_citations: [
          { type: 'lcd', reference_id: 'LCD-33345', section: '§4.2', description: 'LCD for procedure' },
        ],
        appeal_arguments: ['Medical necessity established by clinical evidence'],
      },
      template_used: 'default',
      payer_template_available: false,
      incomplete_sections: [],
      guardrail_intervened: false,
    });

    mockValidateCitations.mockReturnValue({
      validCitations: ['fhir-001', 'cond-002'],
      removedCitations: [],
      hadStrippedCitations: false,
      crossPatientIds: [],
    });

    mockStripHallucinatedContent.mockReturnValue({
      cleanedBody: 'Dear Appeals Department,\n\nWe are writing to appeal the denial of claim claim-001 for patient patient-001. Evidence fhir-001 and cond-002 support medical necessity.\n\nSincerely,\nProvider',
      interventions: [],
    });
  });

  afterEach(() => {
    resetClients();
    vi.clearAllMocks();
    delete process.env.TABLE_NAME;
    delete process.env.LETTERS_BUCKET;
    delete process.env.SNS_TOPIC_ARN;
  });

  // ─── Skip Generation Tests ──────────────────────────────────────────────

  describe('when viability recommendation is do_not_pursue', () => {
    it('should skip letter generation and return null', async () => {
      const input = makeHandlerInput({
        viabilityAssessment: makeViabilityAssessment({
          recommendation: 'do_not_pursue',
          viability_score: 0.15,
        }),
      });

      const result = await handler(input);

      expect(result.appealLetter).toBeNull();
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('do_not_pursue');
      expect(mockGenerateAppealLetter).not.toHaveBeenCalled();
      expect(mockDynamo.send).not.toHaveBeenCalled();
      expect(mockS3.send).not.toHaveBeenCalled();
    });
  });

  // ─── Successful Generation Tests ───────────────────────────────────────

  describe('when viability recommendation is pursue', () => {
    it('should generate and store a complete appeal letter', async () => {
      const input = makeHandlerInput();

      const result = await handler(input);

      expect(result.skipped).toBe(false);
      expect(result.appealLetter).not.toBeNull();
      expect(result.appealLetter!.claim_id).toBe('claim-001');
      expect(result.appealLetter!.version).toBe(1);
      expect(result.appealLetter!.user_edited).toBe(false);
      expect(result.appealLetter!.PK).toBe('TENANT#tenant-001');
      expect(result.appealLetter!.SK).toBe('LETTER#claim-001#1');
    });

    it('should look up regulatory references with correct parameters', async () => {
      const input = makeHandlerInput();

      await handler(input);

      expect(mockLookupRegulatoryReferences).toHaveBeenCalledWith(
        mockDynamo,
        ['CO-50'],
        'medicare',
        'DenialAppeals'
      );
    });

    it('should pass regulatory citations to letter generator', async () => {
      const input = makeHandlerInput();

      await handler(input);

      expect(mockGenerateAppealLetter).toHaveBeenCalledWith(
        expect.objectContaining({
          regulatoryCitations: [
            {
              type: 'lcd',
              reference_id: 'LCD-33345',
              section: '§4.2',
              description: 'Local Coverage Determination for procedure',
            },
          ],
        })
      );
    });

    it('should validate citations against evidence package', async () => {
      const input = makeHandlerInput();

      await handler(input);

      expect(mockValidateCitations).toHaveBeenCalledWith(
        expect.any(String),
        input.evidencePackage
      );
    });

    it('should strip hallucinated content', async () => {
      const input = makeHandlerInput();

      await handler(input);

      expect(mockStripHallucinatedContent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ validCitations: ['fhir-001', 'cond-002'] }),
        'patient-001'
      );
    });

    it('should store letter body in S3 at correct path', async () => {
      const input = makeHandlerInput();

      await handler(input);

      expect(mockS3.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'appeal-letters-bucket',
            Key: 'letters/tenant-001/claim-001/v1.txt',
            ContentType: 'text/plain',
            ServerSideEncryption: 'aws:kms',
          }),
        })
      );
    });

    it('should store AppealLetter record in DynamoDB', async () => {
      const input = makeHandlerInput();

      await handler(input);

      // DynamoDB is called for both regulatory lookup (via mock) and PutCommand
      // The PutCommand should be the second call
      const putCalls = mockDynamo.send.mock.calls.filter(
        (call: any[]) => call[0]?.input?.TableName === 'DenialAppeals' && call[0]?.input?.Item
      );
      expect(putCalls.length).toBe(1);
      const storedItem = putCalls[0][0].input.Item;
      expect(storedItem.PK).toBe('TENANT#tenant-001');
      expect(storedItem.SK).toBe('LETTER#claim-001#1');
      expect(storedItem.claim_id).toBe('claim-001');
      expect(storedItem.version).toBe(1);
      expect(storedItem.user_edited).toBe(false);
    });

    it('should not send SNS notification for complete letters', async () => {
      const input = makeHandlerInput();

      await handler(input);

      expect(mockSns.send).not.toHaveBeenCalled();
    });

    it('should infer medicare payer type from payer_id', async () => {
      const input = makeHandlerInput({
        denialRecord: makeDenialRecord({ payer_id: 'medicare-partb' }),
      });

      await handler(input);

      expect(mockLookupRegulatoryReferences).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'medicare',
        expect.anything()
      );
    });

    it('should infer medicaid payer type from payer_id', async () => {
      const input = makeHandlerInput({
        denialRecord: makeDenialRecord({ payer_id: 'medicaid-state-ca' }),
      });

      await handler(input);

      expect(mockLookupRegulatoryReferences).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'medicaid',
        expect.anything()
      );
    });

    it('should default to commercial payer type', async () => {
      const input = makeHandlerInput({
        denialRecord: makeDenialRecord({ payer_id: 'aetna-ppo' }),
      });

      await handler(input);

      expect(mockLookupRegulatoryReferences).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'commercial',
        expect.anything()
      );
    });
  });

  // ─── Partial Letter Tests ─────────────────────────────────────────────

  describe('partial letter generation (insufficient evidence)', () => {
    it('should generate partial letter when evidence is empty', async () => {
      const input = makeHandlerInput({
        evidencePackage: makeEvidencePackage({ evidence_items: [] }),
      });

      mockGenerateAppealLetter.mockResolvedValue({
        letter_body: 'Dear Appeals Department,\n\nWe are writing to appeal...',
        metadata: {
          patient_id: 'patient-001',
          claim_id: 'claim-001',
          denial_reasons: ['CO-50'],
          cited_evidence_references: [],
          regulatory_citations: [],
          appeal_arguments: ['Appeal of CO-50'],
        },
        template_used: 'default',
        payer_template_available: false,
        incomplete_sections: ['clinical_justification'],
        guardrail_intervened: false,
      });

      mockValidateCitations.mockReturnValue({
        validCitations: [],
        removedCitations: [],
        hadStrippedCitations: false,
        crossPatientIds: [],
      });

      mockStripHallucinatedContent.mockReturnValue({
        cleanedBody: 'Dear Appeals Department,\n\nWe are writing to appeal...',
        interventions: [],
      });

      const result = await handler(input);

      expect(result.appealLetter).not.toBeNull();
      expect(result.appealLetter!.incomplete_sections).toContain('clinical_justification');
      expect(result.appealLetter!.letter_body).toContain('NOTE: This letter is incomplete');
      expect(result.appealLetter!.letter_body).toContain('Clinical Justification');
    });

    it('should send SNS notification for partial letters', async () => {
      const input = makeHandlerInput({
        evidencePackage: makeEvidencePackage({ evidence_items: [] }),
      });

      mockGenerateAppealLetter.mockResolvedValue({
        letter_body: 'Dear Appeals Department,\n\nWe are writing to appeal...',
        metadata: {
          patient_id: 'patient-001',
          claim_id: 'claim-001',
          denial_reasons: ['CO-50'],
          cited_evidence_references: [],
          regulatory_citations: [],
          appeal_arguments: [],
        },
        template_used: 'default',
        payer_template_available: false,
        incomplete_sections: ['clinical_justification'],
        guardrail_intervened: false,
      });

      mockValidateCitations.mockReturnValue({
        validCitations: [],
        removedCitations: [],
        hadStrippedCitations: false,
        crossPatientIds: [],
      });

      mockStripHallucinatedContent.mockReturnValue({
        cleanedBody: 'Dear Appeals Department,\n\nWe are writing to appeal...',
        interventions: [],
      });

      const result = await handler(input);

      expect(mockSns.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TopicArn: 'arn:aws:sns:us-east-1:123456789:notifications',
            Subject: expect.stringContaining('Partial Appeal Letter'),
          }),
        })
      );
    });

    it('should flag letter_body as incomplete when body is too short', async () => {
      const input = makeHandlerInput();

      mockGenerateAppealLetter.mockResolvedValue({
        letter_body: 'Short.',
        metadata: {
          patient_id: 'patient-001',
          claim_id: 'claim-001',
          denial_reasons: ['CO-50'],
          cited_evidence_references: [],
          regulatory_citations: [],
          appeal_arguments: [],
        },
        template_used: 'default',
        payer_template_available: false,
        incomplete_sections: [],
        guardrail_intervened: true,
      });

      mockValidateCitations.mockReturnValue({
        validCitations: [],
        removedCitations: [],
        hadStrippedCitations: false,
        crossPatientIds: [],
      });

      mockStripHallucinatedContent.mockReturnValue({
        cleanedBody: 'Short.',
        interventions: [],
      });

      const result = await handler(input);

      expect(result.appealLetter!.incomplete_sections).toContain('letter_body');
    });
  });

  // ─── Hallucination Stripping Tests ────────────────────────────────────

  describe('hallucination stripping', () => {
    it('should use cleaned body in stored letter when citations are stripped', async () => {
      const input = makeHandlerInput();

      mockStripHallucinatedContent.mockReturnValue({
        cleanedBody: 'Dear Appeals Department,\n\nEvidence fhir-001 supports this. [citation removed] was invalid.\n\nSincerely,\nProvider',
        interventions: [
          {
            timestamp: '2024-01-20T10:20:00Z',
            type: 'hallucinated_citation',
            detail: 'FHIR resource ID "fhir-bad" not found',
            resourceId: 'fhir-bad',
          },
        ],
      });

      const result = await handler(input);

      expect(result.appealLetter!.letter_body).toContain('[citation removed]');
      expect(result.appealLetter!.letter_body).not.toContain('fhir-bad');
    });
  });

  // ─── Environment Variable Edge Cases ──────────────────────────────────

  describe('environment variable handling', () => {
    it('should skip S3 storage when LETTERS_BUCKET is not set', async () => {
      delete process.env.LETTERS_BUCKET;
      const input = makeHandlerInput();

      const result = await handler(input);

      expect(result.appealLetter).not.toBeNull();
      expect(mockS3.send).not.toHaveBeenCalled();
    });

    it('should skip SNS notification when SNS_TOPIC_ARN is not set', async () => {
      delete process.env.SNS_TOPIC_ARN;
      const input = makeHandlerInput({
        evidencePackage: makeEvidencePackage({ evidence_items: [] }),
      });

      mockGenerateAppealLetter.mockResolvedValue({
        letter_body: 'Dear Appeals Department,\n\nWe are writing to appeal...',
        metadata: {
          patient_id: 'patient-001',
          claim_id: 'claim-001',
          denial_reasons: ['CO-50'],
          cited_evidence_references: [],
          regulatory_citations: [],
          appeal_arguments: [],
        },
        template_used: 'default',
        payer_template_available: false,
        incomplete_sections: ['clinical_justification'],
        guardrail_intervened: false,
      });

      mockValidateCitations.mockReturnValue({
        validCitations: [],
        removedCitations: [],
        hadStrippedCitations: false,
        crossPatientIds: [],
      });

      mockStripHallucinatedContent.mockReturnValue({
        cleanedBody: 'Dear Appeals Department,\n\nWe are writing to appeal...',
        interventions: [],
      });

      const result = await handler(input);

      expect(result.appealLetter).not.toBeNull();
      expect(mockSns.send).not.toHaveBeenCalled();
    });
  });
});
