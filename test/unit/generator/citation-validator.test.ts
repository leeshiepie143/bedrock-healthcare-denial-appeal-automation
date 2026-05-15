import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateCitations,
  lookupRegulatoryReferences,
  stripHallucinatedContent,
  parseFhirResourceIds,
  parsePatientIds,
  type CitationValidationResult,
  type RegulatoryReferenceRecord,
} from '@lambdas/generator/citation-validator';
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

function makeEvidencePackage(items: EvidenceItem[], patientId = 'patient-001'): EvidencePackage {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'EVIDENCE#claim-001',
    claim_id: 'claim-001',
    patient_id: patientId,
    evidence_items: items,
    total_evidence_count: items.length,
    retrieval_timestamp: '2024-01-20T10:00:00Z',
    retrieval_duration_ms: 1500,
    manual_review_required: false,
  };
}

function makeMockDynamoClient(items: RegulatoryReferenceRecord[]) {
  return {
    send: vi.fn().mockResolvedValue({ Items: items }),
  } as any;
}

// ─── Tests: parseFhirResourceIds ────────────────────────────────────────────

describe('parseFhirResourceIds', () => {
  it('should extract fhir- prefixed IDs', () => {
    const body = 'The encounter fhir-abc123 shows treatment on 2024-01-15.';
    expect(parseFhirResourceIds(body)).toEqual(['fhir-abc123']);
  });

  it('should extract cond- prefixed IDs', () => {
    const body = 'Condition cond-diabetes-001 was documented.';
    expect(parseFhirResourceIds(body)).toEqual(['cond-diabetes-001']);
  });

  it('should extract proc- prefixed IDs', () => {
    const body = 'Procedure proc-knee-replacement was performed.';
    expect(parseFhirResourceIds(body)).toEqual(['proc-knee-replacement']);
  });

  it('should extract enc- prefixed IDs', () => {
    const body = 'Encounter enc-2024-01-15 documents the visit.';
    expect(parseFhirResourceIds(body)).toEqual(['enc-2024-01-15']);
  });

  it('should extract dr- prefixed IDs', () => {
    const body = 'Diagnostic report dr-lab-results confirms findings.';
    expect(parseFhirResourceIds(body)).toEqual(['dr-lab-results']);
  });

  it('should extract doc- prefixed IDs', () => {
    const body = 'Document reference doc-clinical-note supports the claim.';
    expect(parseFhirResourceIds(body)).toEqual(['doc-clinical-note']);
  });

  it('should extract multiple different IDs', () => {
    const body = 'Evidence includes fhir-001, cond-002, and proc-003.';
    const result = parseFhirResourceIds(body);
    expect(result).toContain('fhir-001');
    expect(result).toContain('cond-002');
    expect(result).toContain('proc-003');
    expect(result).toHaveLength(3);
  });

  it('should deduplicate repeated IDs', () => {
    const body = 'Reference fhir-001 is cited here and fhir-001 is cited again.';
    expect(parseFhirResourceIds(body)).toEqual(['fhir-001']);
  });

  it('should return empty array when no IDs found', () => {
    const body = 'This letter contains no FHIR resource references.';
    expect(parseFhirResourceIds(body)).toEqual([]);
  });

  it('should handle empty string', () => {
    expect(parseFhirResourceIds('')).toEqual([]);
  });
});

// ─── Tests: parsePatientIds ─────────────────────────────────────────────────

describe('parsePatientIds', () => {
  it('should extract patient- prefixed IDs', () => {
    const body = 'Patient patient-001 was treated on 2024-01-15.';
    expect(parsePatientIds(body)).toEqual(['patient-001']);
  });

  it('should extract pat- prefixed IDs', () => {
    const body = 'Record for pat-abc123 shows diagnosis.';
    expect(parsePatientIds(body)).toEqual(['pat-abc123']);
  });

  it('should deduplicate repeated patient IDs', () => {
    const body = 'patient-001 was seen. patient-001 was discharged.';
    expect(parsePatientIds(body)).toEqual(['patient-001']);
  });

  it('should extract multiple different patient IDs', () => {
    const body = 'patient-001 and patient-002 records were found.';
    const result = parsePatientIds(body);
    expect(result).toContain('patient-001');
    expect(result).toContain('patient-002');
    expect(result).toHaveLength(2);
  });

  it('should return empty array when no patient IDs found', () => {
    const body = 'No patient identifiers in this text.';
    expect(parsePatientIds(body)).toEqual([]);
  });
});

// ─── Tests: validateCitations ───────────────────────────────────────────────

describe('validateCitations', () => {
  it('should mark all citations as valid when they exist in Evidence_Package', () => {
    const items = [
      makeEvidenceItem({ fhir_resource_id: 'fhir-001' }),
      makeEvidenceItem({ fhir_resource_id: 'cond-002' }),
    ];
    const pkg = makeEvidencePackage(items);
    const letterBody = 'Evidence fhir-001 and cond-002 support this appeal.';

    const result = validateCitations(letterBody, pkg);

    expect(result.validCitations).toEqual(['fhir-001', 'cond-002']);
    expect(result.removedCitations).toEqual([]);
    expect(result.hadStrippedCitations).toBe(false);
    expect(result.crossPatientIds).toEqual([]);
  });

  it('should identify hallucinated citations not in Evidence_Package', () => {
    const items = [
      makeEvidenceItem({ fhir_resource_id: 'fhir-001' }),
    ];
    const pkg = makeEvidencePackage(items);
    const letterBody = 'Evidence fhir-001 and fhir-999 support this appeal.';

    const result = validateCitations(letterBody, pkg);

    expect(result.validCitations).toEqual(['fhir-001']);
    expect(result.removedCitations).toEqual(['fhir-999']);
    expect(result.hadStrippedCitations).toBe(true);
  });

  it('should detect cross-patient data', () => {
    const items = [
      makeEvidenceItem({ fhir_resource_id: 'fhir-001' }),
    ];
    const pkg = makeEvidencePackage(items, 'patient-001');
    const letterBody = 'Patient patient-001 and patient-999 records show...';

    const result = validateCitations(letterBody, pkg);

    expect(result.crossPatientIds).toEqual(['patient-999']);
    expect(result.hadStrippedCitations).toBe(true);
  });

  it('should not flag the correct patient ID as cross-patient', () => {
    const items = [
      makeEvidenceItem({ fhir_resource_id: 'fhir-001' }),
    ];
    const pkg = makeEvidencePackage(items, 'patient-001');
    const letterBody = 'Patient patient-001 was treated. Evidence fhir-001.';

    const result = validateCitations(letterBody, pkg);

    expect(result.crossPatientIds).toEqual([]);
    expect(result.hadStrippedCitations).toBe(false);
  });

  it('should handle letter with no citations', () => {
    const items = [
      makeEvidenceItem({ fhir_resource_id: 'fhir-001' }),
    ];
    const pkg = makeEvidencePackage(items);
    const letterBody = 'This appeal letter has no specific resource references.';

    const result = validateCitations(letterBody, pkg);

    expect(result.validCitations).toEqual([]);
    expect(result.removedCitations).toEqual([]);
    expect(result.hadStrippedCitations).toBe(false);
  });

  it('should handle empty Evidence_Package', () => {
    const pkg = makeEvidencePackage([]);
    const letterBody = 'Evidence fhir-001 supports this claim.';

    const result = validateCitations(letterBody, pkg);

    expect(result.validCitations).toEqual([]);
    expect(result.removedCitations).toEqual(['fhir-001']);
    expect(result.hadStrippedCitations).toBe(true);
  });

  it('should handle both hallucinated citations and cross-patient data', () => {
    const items = [
      makeEvidenceItem({ fhir_resource_id: 'fhir-001' }),
    ];
    const pkg = makeEvidencePackage(items, 'patient-001');
    const letterBody = 'fhir-001 and fhir-hallucinated for patient-002.';

    const result = validateCitations(letterBody, pkg);

    expect(result.validCitations).toEqual(['fhir-001']);
    expect(result.removedCitations).toEqual(['fhir-hallucinated']);
    expect(result.crossPatientIds).toEqual(['patient-002']);
    expect(result.hadStrippedCitations).toBe(true);
  });
});

// ─── Tests: lookupRegulatoryReferences ──────────────────────────────────────

describe('lookupRegulatoryReferences', () => {
  it('should return matching regulatory references for CARC code and payer type', async () => {
    const items: RegulatoryReferenceRecord[] = [
      {
        PK: 'REG_REF',
        SK: 'lcd#LCD-33345',
        reference_id: 'LCD-33345',
        type: 'lcd',
        section: '§4.2',
        description: 'Local Coverage Determination for knee replacement',
        applicable_carc_codes: ['CO-50', 'CO-97'],
        payer_types: ['medicare'],
      },
    ];
    const client = makeMockDynamoClient(items);

    const result = await lookupRegulatoryReferences(client, ['CO-50'], 'medicare', 'DenialAppeals');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'lcd',
      reference_id: 'LCD-33345',
      section: '§4.2',
      description: 'Local Coverage Determination for knee replacement',
    });
  });

  it('should return empty array when no CARC codes match', async () => {
    const items: RegulatoryReferenceRecord[] = [
      {
        PK: 'REG_REF',
        SK: 'lcd#LCD-33345',
        reference_id: 'LCD-33345',
        type: 'lcd',
        section: '§4.2',
        description: 'Local Coverage Determination for knee replacement',
        applicable_carc_codes: ['CO-50'],
        payer_types: ['medicare'],
      },
    ];
    const client = makeMockDynamoClient(items);

    const result = await lookupRegulatoryReferences(client, ['CO-999'], 'medicare', 'DenialAppeals');

    expect(result).toEqual([]);
  });

  it('should return empty array when payer type does not match', async () => {
    const items: RegulatoryReferenceRecord[] = [
      {
        PK: 'REG_REF',
        SK: 'lcd#LCD-33345',
        reference_id: 'LCD-33345',
        type: 'lcd',
        section: '§4.2',
        description: 'LCD for knee replacement',
        applicable_carc_codes: ['CO-50'],
        payer_types: ['medicare'],
      },
    ];
    const client = makeMockDynamoClient(items);

    const result = await lookupRegulatoryReferences(client, ['CO-50'], 'commercial', 'DenialAppeals');

    expect(result).toEqual([]);
  });

  it('should return empty array when denialReasonCodes is empty', async () => {
    const client = makeMockDynamoClient([]);

    const result = await lookupRegulatoryReferences(client, [], 'medicare', 'DenialAppeals');

    expect(result).toEqual([]);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('should return multiple matching references', async () => {
    const items: RegulatoryReferenceRecord[] = [
      {
        PK: 'REG_REF',
        SK: 'lcd#LCD-33345',
        reference_id: 'LCD-33345',
        type: 'lcd',
        section: '§4.2',
        description: 'LCD for knee replacement',
        applicable_carc_codes: ['CO-50'],
        payer_types: ['medicare'],
      },
      {
        PK: 'REG_REF',
        SK: 'ncd#NCD-150.1',
        reference_id: 'NCD-150.1',
        type: 'ncd',
        section: '§150.1',
        description: 'National Coverage Determination for joint procedures',
        applicable_carc_codes: ['CO-50', 'CO-97'],
        payer_types: ['medicare', 'medicaid'],
      },
      {
        PK: 'REG_REF',
        SK: 'erisa#502a',
        reference_id: 'ERISA-502a',
        type: 'erisa',
        section: '§502(a)',
        description: 'ERISA civil enforcement provision',
        applicable_carc_codes: ['CO-50'],
        payer_types: ['commercial'],
      },
    ];
    const client = makeMockDynamoClient(items);

    const result = await lookupRegulatoryReferences(client, ['CO-50'], 'medicare', 'DenialAppeals');

    expect(result).toHaveLength(2);
    expect(result.map(r => r.reference_id)).toContain('LCD-33345');
    expect(result.map(r => r.reference_id)).toContain('NCD-150.1');
  });

  it('should match on any of multiple denial reason codes', async () => {
    const items: RegulatoryReferenceRecord[] = [
      {
        PK: 'REG_REF',
        SK: 'state_mandate#CA-001',
        reference_id: 'CA-001',
        type: 'state_mandate',
        section: 'CA Health & Safety Code §1371.4',
        description: 'California timely access to care',
        applicable_carc_codes: ['CO-97'],
        payer_types: ['commercial', 'medicare'],
      },
    ];
    const client = makeMockDynamoClient(items);

    const result = await lookupRegulatoryReferences(
      client,
      ['CO-50', 'CO-97'],
      'commercial',
      'DenialAppeals'
    );

    expect(result).toHaveLength(1);
    expect(result[0].reference_id).toBe('CA-001');
  });

  it('should handle DynamoDB returning no items', async () => {
    const client = makeMockDynamoClient([]);

    const result = await lookupRegulatoryReferences(client, ['CO-50'], 'medicare', 'DenialAppeals');

    expect(result).toEqual([]);
  });
});

// ─── Tests: stripHallucinatedContent ────────────────────────────────────────

describe('stripHallucinatedContent', () => {
  it('should replace hallucinated FHIR IDs with [citation removed]', () => {
    const validationResult: CitationValidationResult = {
      validCitations: ['fhir-001'],
      removedCitations: ['fhir-999'],
      hadStrippedCitations: true,
      crossPatientIds: [],
    };
    const letterBody = 'Evidence fhir-001 and fhir-999 support this claim.';

    const { cleanedBody, interventions } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(cleanedBody).toBe('Evidence fhir-001 and [citation removed] support this claim.');
    expect(interventions).toHaveLength(1);
    expect(interventions[0].type).toBe('hallucinated_citation');
    expect(interventions[0].resourceId).toBe('fhir-999');
  });

  it('should replace cross-patient IDs with [citation removed]', () => {
    const validationResult: CitationValidationResult = {
      validCitations: ['fhir-001'],
      removedCitations: [],
      hadStrippedCitations: true,
      crossPatientIds: ['patient-999'],
    };
    const letterBody = 'Patient patient-999 records show treatment.';

    const { cleanedBody, interventions } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(cleanedBody).toBe('Patient [citation removed] records show treatment.');
    expect(interventions).toHaveLength(1);
    expect(interventions[0].type).toBe('cross_patient_data');
    expect(interventions[0].resourceId).toBe('patient-999');
  });

  it('should handle multiple hallucinated citations', () => {
    const validationResult: CitationValidationResult = {
      validCitations: [],
      removedCitations: ['fhir-aaa', 'cond-bbb'],
      hadStrippedCitations: true,
      crossPatientIds: [],
    };
    const letterBody = 'References fhir-aaa and cond-bbb are cited.';

    const { cleanedBody, interventions } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(cleanedBody).toBe('References [citation removed] and [citation removed] are cited.');
    expect(interventions).toHaveLength(2);
  });

  it('should handle both hallucinated citations and cross-patient data', () => {
    const validationResult: CitationValidationResult = {
      validCitations: ['fhir-001'],
      removedCitations: ['fhir-bad'],
      hadStrippedCitations: true,
      crossPatientIds: ['patient-other'],
    };
    const letterBody = 'fhir-001 valid, fhir-bad invalid, patient-other wrong.';

    const { cleanedBody, interventions } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(cleanedBody).toBe('fhir-001 valid, [citation removed] invalid, [citation removed] wrong.');
    expect(interventions).toHaveLength(2);
    expect(interventions[0].type).toBe('hallucinated_citation');
    expect(interventions[1].type).toBe('cross_patient_data');
  });

  it('should not modify letter when no citations need stripping', () => {
    const validationResult: CitationValidationResult = {
      validCitations: ['fhir-001'],
      removedCitations: [],
      hadStrippedCitations: false,
      crossPatientIds: [],
    };
    const letterBody = 'Evidence fhir-001 supports this claim.';

    const { cleanedBody, interventions } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(cleanedBody).toBe(letterBody);
    expect(interventions).toEqual([]);
  });

  it('should replace all occurrences of a hallucinated ID', () => {
    const validationResult: CitationValidationResult = {
      validCitations: [],
      removedCitations: ['fhir-bad'],
      hadStrippedCitations: true,
      crossPatientIds: [],
    };
    const letterBody = 'First fhir-bad reference. Second fhir-bad reference.';

    const { cleanedBody } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(cleanedBody).toBe('First [citation removed] reference. Second [citation removed] reference.');
  });

  it('should include timestamp in interventions', () => {
    const validationResult: CitationValidationResult = {
      validCitations: [],
      removedCitations: ['fhir-bad'],
      hadStrippedCitations: true,
      crossPatientIds: [],
    };
    const letterBody = 'Reference fhir-bad is invalid.';

    const { interventions } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(interventions[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should handle IDs with special regex characters', () => {
    const validationResult: CitationValidationResult = {
      validCitations: [],
      removedCitations: ['fhir-test_id-123'],
      hadStrippedCitations: true,
      crossPatientIds: [],
    };
    const letterBody = 'Reference fhir-test_id-123 is invalid.';

    const { cleanedBody } = stripHallucinatedContent(
      letterBody,
      validationResult,
      'patient-001'
    );

    expect(cleanedBody).toBe('Reference [citation removed] is invalid.');
  });
});
