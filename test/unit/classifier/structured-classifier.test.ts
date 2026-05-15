/**
 * Unit tests for Structured EDI Classifier
 *
 * Tests CARC code parsing, ranking logic, DynamoDB mapping lookups,
 * and the full classification flow.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseCarcCodesFromText,
  parseSingleCarcSegment,
  isDollarRankingAvailable,
  rankCarcEntries,
  buildCarcMappingKey,
  lookupCarcMappings,
  buildCarcCodes,
  classifyStructuredEDI,
  CARC_MAP_PK,
  CARC_CODE_SK_PREFIX,
  STRUCTURED_EDI_CONFIDENCE,
} from '@lambdas/classifier/structured-classifier';
import type { ParsedCarcEntry, CarcMappingRecord } from '@lambdas/classifier/structured-classifier';
import type { DenialRecord } from '@shared/models';

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

function createMockMappings(): Map<string, CarcMappingRecord> {
  const mappings = new Map<string, CarcMappingRecord>();
  mappings.set('45', {
    code: '45',
    description: 'Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.',
    required_evidence_categories: ['medical_necessity', 'fee_schedule'],
    group_code_description: 'Contractual Obligation',
  });
  mappings.set('253', {
    code: '253',
    description: 'Sequestration - Loss in federal spending.',
    required_evidence_categories: ['sequestration_documentation'],
    group_code_description: 'Contractual Obligation',
  });
  mappings.set('50', {
    code: '50',
    description: 'These are non-covered services because this is not deemed a medical necessity by the payer.',
    required_evidence_categories: ['medical_necessity', 'clinical_notes', 'prior_auth'],
    group_code_description: 'Contractual Obligation',
  });
  return mappings;
}

// ─── parseCarcCodesFromText Tests ───────────────────────────────────────────

describe('parseCarcCodesFromText', () => {
  it('should parse standard format with dollar amounts', () => {
    const result = parseCarcCodesFromText('CO-45: $100.00; CO-253: $50.00');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      group_code: 'CO',
      reason_code: '45',
      dollar_amount: 100.00,
      original_position: 0,
    });
    expect(result[1]).toEqual({
      group_code: 'CO',
      reason_code: '253',
      dollar_amount: 50.00,
      original_position: 1,
    });
  });

  it('should parse codes without dollar amounts', () => {
    const result = parseCarcCodesFromText('CO-45; PR-96');
    expect(result).toHaveLength(2);
    expect(result[0].dollar_amount).toBeNull();
    expect(result[1].dollar_amount).toBeNull();
    expect(result[0].group_code).toBe('CO');
    expect(result[0].reason_code).toBe('45');
    expect(result[1].group_code).toBe('PR');
    expect(result[1].reason_code).toBe('96');
  });

  it('should handle single CARC code', () => {
    const result = parseCarcCodesFromText('CO-45: $200.00');
    expect(result).toHaveLength(1);
    expect(result[0].reason_code).toBe('45');
    expect(result[0].dollar_amount).toBe(200.00);
  });

  it('should handle empty string', () => {
    const result = parseCarcCodesFromText('');
    expect(result).toHaveLength(0);
  });

  it('should handle whitespace-only string', () => {
    const result = parseCarcCodesFromText('   ');
    expect(result).toHaveLength(0);
  });

  it('should handle multiple group codes', () => {
    const result = parseCarcCodesFromText('CO-45: $100.00; PR-96: $25.00; OA-18: $75.00');
    expect(result).toHaveLength(3);
    expect(result[0].group_code).toBe('CO');
    expect(result[1].group_code).toBe('PR');
    expect(result[2].group_code).toBe('OA');
  });

  it('should handle amounts with commas', () => {
    const result = parseCarcCodesFromText('CO-45: $1,234.56');
    expect(result).toHaveLength(1);
    expect(result[0].dollar_amount).toBe(1234.56);
  });

  it('should skip unparseable segments', () => {
    const result = parseCarcCodesFromText('CO-45: $100.00; INVALID; CO-253: $50.00');
    expect(result).toHaveLength(2);
    expect(result[0].reason_code).toBe('45');
    expect(result[1].reason_code).toBe('253');
    // Position should reflect original order including skipped segments
    expect(result[0].original_position).toBe(0);
    expect(result[1].original_position).toBe(2);
  });

  it('should handle up to 25 denial reasons', () => {
    const codes = Array.from({ length: 25 }, (_, i) => `CO-${i + 1}: $${(i + 1) * 10}.00`);
    const result = parseCarcCodesFromText(codes.join('; '));
    expect(result).toHaveLength(25);
    expect(result[24].reason_code).toBe('25');
    expect(result[24].dollar_amount).toBe(250.00);
  });
});

// ─── parseSingleCarcSegment Tests ───────────────────────────────────────────

describe('parseSingleCarcSegment', () => {
  it('should parse segment with dollar amount', () => {
    const result = parseSingleCarcSegment('CO-45: $100.00', 0);
    expect(result).toEqual({
      group_code: 'CO',
      reason_code: '45',
      dollar_amount: 100.00,
      original_position: 0,
    });
  });

  it('should parse segment without dollar sign', () => {
    const result = parseSingleCarcSegment('CO-45: 100.00', 0);
    expect(result).toEqual({
      group_code: 'CO',
      reason_code: '45',
      dollar_amount: 100.00,
      original_position: 0,
    });
  });

  it('should parse segment without amount', () => {
    const result = parseSingleCarcSegment('PR-96', 3);
    expect(result).toEqual({
      group_code: 'PR',
      reason_code: '96',
      dollar_amount: null,
      original_position: 3,
    });
  });

  it('should return null for invalid format', () => {
    expect(parseSingleCarcSegment('INVALID', 0)).toBeNull();
    expect(parseSingleCarcSegment('', 0)).toBeNull();
    expect(parseSingleCarcSegment('45', 0)).toBeNull();
    expect(parseSingleCarcSegment('X-45: $100', 0)).toBeNull(); // single char group
  });

  it('should handle zero dollar amount', () => {
    const result = parseSingleCarcSegment('CO-45: $0.00', 0);
    expect(result).not.toBeNull();
    expect(result!.dollar_amount).toBe(0);
  });
});

// ─── isDollarRankingAvailable Tests ─────────────────────────────────────────

describe('isDollarRankingAvailable', () => {
  it('should return true when all entries have positive dollar amounts', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 100, original_position: 0 },
      { group_code: 'CO', reason_code: '253', dollar_amount: 50, original_position: 1 },
    ];
    expect(isDollarRankingAvailable(entries)).toBe(true);
  });

  it('should return false when any entry has null dollar amount', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 100, original_position: 0 },
      { group_code: 'CO', reason_code: '253', dollar_amount: null, original_position: 1 },
    ];
    expect(isDollarRankingAvailable(entries)).toBe(false);
  });

  it('should return false when any entry has zero dollar amount', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 100, original_position: 0 },
      { group_code: 'CO', reason_code: '253', dollar_amount: 0, original_position: 1 },
    ];
    expect(isDollarRankingAvailable(entries)).toBe(false);
  });

  it('should return false for empty array', () => {
    expect(isDollarRankingAvailable([])).toBe(false);
  });
});

// ─── rankCarcEntries Tests ──────────────────────────────────────────────────

describe('rankCarcEntries', () => {
  it('should rank by dollar amount descending when available', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 50, original_position: 0 },
      { group_code: 'CO', reason_code: '253', dollar_amount: 200, original_position: 1 },
      { group_code: 'PR', reason_code: '96', dollar_amount: 100, original_position: 2 },
    ];
    const ranked = rankCarcEntries(entries, true);
    expect(ranked[0].reason_code).toBe('253'); // $200
    expect(ranked[1].reason_code).toBe('96');  // $100
    expect(ranked[2].reason_code).toBe('45');  // $50
  });

  it('should rank by document order when dollar ranking unavailable', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '253', dollar_amount: null, original_position: 2 },
      { group_code: 'CO', reason_code: '45', dollar_amount: null, original_position: 0 },
      { group_code: 'PR', reason_code: '96', dollar_amount: null, original_position: 1 },
    ];
    const ranked = rankCarcEntries(entries, false);
    expect(ranked[0].reason_code).toBe('45');  // position 0
    expect(ranked[1].reason_code).toBe('96');  // position 1
    expect(ranked[2].reason_code).toBe('253'); // position 2
  });

  it('should not mutate the original array', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 50, original_position: 0 },
      { group_code: 'CO', reason_code: '253', dollar_amount: 200, original_position: 1 },
    ];
    const originalFirst = entries[0].reason_code;
    rankCarcEntries(entries, true);
    expect(entries[0].reason_code).toBe(originalFirst);
  });

  it('should handle empty array', () => {
    expect(rankCarcEntries([], true)).toEqual([]);
    expect(rankCarcEntries([], false)).toEqual([]);
  });

  it('should handle single entry', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 100, original_position: 0 },
    ];
    const ranked = rankCarcEntries(entries, true);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].reason_code).toBe('45');
  });
});

// ─── buildCarcMappingKey Tests ──────────────────────────────────────────────

describe('buildCarcMappingKey', () => {
  it('should build correct PK and SK', () => {
    const key = buildCarcMappingKey('45');
    expect(key.PK).toBe('CARC_MAP');
    expect(key.SK).toBe('CODE#45');
  });

  it('should handle multi-digit codes', () => {
    const key = buildCarcMappingKey('253');
    expect(key.SK).toBe('CODE#253');
  });
});

// ─── buildCarcCodes Tests ───────────────────────────────────────────────────

describe('buildCarcCodes', () => {
  it('should build CarcCode objects with mapping data', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 100, original_position: 0 },
      { group_code: 'CO', reason_code: '253', dollar_amount: 50, original_position: 1 },
    ];
    const mappings = createMockMappings();

    const { carcCodes, unmappedCodes } = buildCarcCodes(entries, mappings, true);

    expect(carcCodes).toHaveLength(2);
    expect(unmappedCodes).toHaveLength(0);

    expect(carcCodes[0].code).toBe('45');
    expect(carcCodes[0].description).toContain('Charge exceeds fee schedule');
    expect(carcCodes[0].confidence).toBe(1.0);
    expect(carcCodes[0].dollar_amount).toBe(100);
    expect(carcCodes[0].rank).toBe(1);
    expect(carcCodes[0].required_evidence_categories).toContain('medical_necessity');

    expect(carcCodes[1].code).toBe('253');
    expect(carcCodes[1].rank).toBe(2);
    expect(carcCodes[1].dollar_amount).toBe(50);
  });

  it('should handle unmapped codes gracefully', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '999', dollar_amount: 100, original_position: 0 },
    ];
    const mappings = new Map<string, CarcMappingRecord>();

    const { carcCodes, unmappedCodes } = buildCarcCodes(entries, mappings, true);

    expect(carcCodes).toHaveLength(1);
    expect(unmappedCodes).toEqual(['999']);
    expect(carcCodes[0].description).toContain('unmapped');
    expect(carcCodes[0].required_evidence_categories).toEqual([]);
    expect(carcCodes[0].confidence).toBe(1.0);
  });

  it('should set dollar_amount to null when ranking unavailable', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: null, original_position: 0 },
    ];
    const mappings = createMockMappings();

    const { carcCodes } = buildCarcCodes(entries, mappings, false);

    expect(carcCodes[0].dollar_amount).toBeNull();
  });

  it('should assign sequential ranks starting from 1', () => {
    const entries: ParsedCarcEntry[] = [
      { group_code: 'CO', reason_code: '45', dollar_amount: 200, original_position: 0 },
      { group_code: 'CO', reason_code: '253', dollar_amount: 100, original_position: 1 },
      { group_code: 'CO', reason_code: '50', dollar_amount: 50, original_position: 2 },
    ];
    const mappings = createMockMappings();

    const { carcCodes } = buildCarcCodes(entries, mappings, true);

    expect(carcCodes[0].rank).toBe(1);
    expect(carcCodes[1].rank).toBe(2);
    expect(carcCodes[2].rank).toBe(3);
  });
});

// ─── lookupCarcMappings Tests ───────────────────────────────────────────────

describe('lookupCarcMappings', () => {
  it('should return mappings for found codes', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Responses: {
          DenialAppeals: [
            {
              code: '45',
              description: 'Charge exceeds fee schedule',
              required_evidence_categories: ['medical_necessity'],
              group_code_description: 'Contractual Obligation',
            },
          ],
        },
      }),
    };

    const result = await lookupCarcMappings(mockClient, ['45']);
    expect(result.size).toBe(1);
    expect(result.get('45')?.description).toBe('Charge exceeds fee schedule');
  });

  it('should return empty map for empty codes array', async () => {
    const mockClient = { send: vi.fn() };
    const result = await lookupCarcMappings(mockClient, []);
    expect(result.size).toBe(0);
    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it('should deduplicate codes before lookup', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Responses: {
          DenialAppeals: [
            {
              code: '45',
              description: 'Charge exceeds fee schedule',
              required_evidence_categories: ['medical_necessity'],
              group_code_description: 'Contractual Obligation',
            },
          ],
        },
      }),
    };

    await lookupCarcMappings(mockClient, ['45', '45', '45']);
    // Should only send one batch with one key
    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });

  it('should handle DynamoDB errors gracefully', async () => {
    const mockClient = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB timeout')),
    };

    const result = await lookupCarcMappings(mockClient, ['45']);
    expect(result.size).toBe(0);
  });
});

// ─── classifyStructuredEDI Integration Tests ────────────────────────────────

describe('classifyStructuredEDI', () => {
  it('should classify a denial record with dollar amounts', async () => {
    const denialRecord = createMockDenialRecord({
      raw_denial_reason_text: 'CO-45: $100.00; CO-253: $50.00',
    });

    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Responses: {
          DenialAppeals: [
            {
              code: '45',
              description: 'Charge exceeds fee schedule',
              required_evidence_categories: ['medical_necessity', 'fee_schedule'],
              group_code_description: 'Contractual Obligation',
            },
            {
              code: '253',
              description: 'Sequestration',
              required_evidence_categories: ['sequestration_documentation'],
              group_code_description: 'Contractual Obligation',
            },
          ],
        },
      }),
    };

    const result = await classifyStructuredEDI(denialRecord, mockClient);

    expect(result.classifiedDenial.claim_id).toBe('CLM001');
    expect(result.classifiedDenial.classification_method).toBe('structured_edi');
    expect(result.classifiedDenial.dollar_ranking_available).toBe(true);
    expect(result.classifiedDenial.review_status).toBe('auto_classified');
    expect(result.classifiedDenial.carc_codes).toHaveLength(2);
    expect(result.classifiedDenial.rarc_codes).toEqual([]);

    // Ranked by dollar amount descending
    expect(result.classifiedDenial.carc_codes[0].code).toBe('45');
    expect(result.classifiedDenial.carc_codes[0].rank).toBe(1);
    expect(result.classifiedDenial.carc_codes[0].dollar_amount).toBe(100);

    expect(result.classifiedDenial.carc_codes[1].code).toBe('253');
    expect(result.classifiedDenial.carc_codes[1].rank).toBe(2);
    expect(result.classifiedDenial.carc_codes[1].dollar_amount).toBe(50);
  });

  it('should classify a denial record without dollar amounts', async () => {
    const denialRecord = createMockDenialRecord({
      raw_denial_reason_text: 'CO-45; CO-253',
    });

    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Responses: {
          DenialAppeals: [
            {
              code: '45',
              description: 'Charge exceeds fee schedule',
              required_evidence_categories: ['medical_necessity'],
              group_code_description: 'Contractual Obligation',
            },
            {
              code: '253',
              description: 'Sequestration',
              required_evidence_categories: ['sequestration_documentation'],
              group_code_description: 'Contractual Obligation',
            },
          ],
        },
      }),
    };

    const result = await classifyStructuredEDI(denialRecord, mockClient);

    expect(result.classifiedDenial.dollar_ranking_available).toBe(false);
    // Ranked by document order
    expect(result.classifiedDenial.carc_codes[0].code).toBe('45');
    expect(result.classifiedDenial.carc_codes[0].rank).toBe(1);
    expect(result.classifiedDenial.carc_codes[0].dollar_amount).toBeNull();

    expect(result.classifiedDenial.carc_codes[1].code).toBe('253');
    expect(result.classifiedDenial.carc_codes[1].rank).toBe(2);
    expect(result.classifiedDenial.carc_codes[1].dollar_amount).toBeNull();
  });

  it('should set correct PK and SK on ClassifiedDenial', async () => {
    const denialRecord = createMockDenialRecord({
      tenant_id: 'my-tenant',
      claim_id: 'CLM999',
      raw_denial_reason_text: 'CO-45: $100.00',
    });

    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Responses: { DenialAppeals: [] },
      }),
    };

    const result = await classifyStructuredEDI(denialRecord, mockClient);

    expect(result.classifiedDenial.PK).toBe('TENANT#my-tenant');
    expect(result.classifiedDenial.SK).toBe('CLASSIFICATION#CLM999');
  });

  it('should handle DynamoDB failure gracefully', async () => {
    const denialRecord = createMockDenialRecord({
      raw_denial_reason_text: 'CO-45: $100.00',
    });

    const mockClient = {
      send: vi.fn().mockRejectedValue(new Error('Service unavailable')),
    };

    const result = await classifyStructuredEDI(denialRecord, mockClient);

    // Should still produce a result with unmapped codes
    expect(result.classifiedDenial.carc_codes).toHaveLength(1);
    expect(result.classifiedDenial.carc_codes[0].code).toBe('45');
    expect(result.classifiedDenial.carc_codes[0].description).toContain('unmapped');
    expect(result.unmappedCodes).toContain('45');
  });

  it('should set confidence to 1.0 for all structured EDI codes', async () => {
    const denialRecord = createMockDenialRecord({
      raw_denial_reason_text: 'CO-45: $100.00; PR-96: $50.00; OA-18: $25.00',
    });

    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Responses: { DenialAppeals: [] },
      }),
    };

    const result = await classifyStructuredEDI(denialRecord, mockClient);

    for (const code of result.classifiedDenial.carc_codes) {
      expect(code.confidence).toBe(STRUCTURED_EDI_CONFIDENCE);
    }
  });

  it('should produce valid ISO 8601 classified_at timestamp', async () => {
    const denialRecord = createMockDenialRecord();
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Responses: { DenialAppeals: [] },
      }),
    };

    const result = await classifyStructuredEDI(denialRecord, mockClient);

    const timestamp = new Date(result.classifiedDenial.classified_at);
    expect(timestamp.getTime()).not.toBeNaN();
  });
});
