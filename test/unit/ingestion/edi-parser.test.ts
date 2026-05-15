/**
 * Unit tests for EDI 835/277 Parser
 *
 * Tests segment parsing logic, field extraction, format detection,
 * file size/page count limits, and deduplication key building.
 */

import { describe, it, expect } from 'vitest';
import {
  parseEDI,
  parseEDI835,
  parseEDI277,
  detectEDIFormat,
  detectDelimiters,
  splitSegments,
  splitElements,
  splitSubElements,
  convertEDIDate,
  validateFileLimits,
  buildDeduplicationKey,
  MAX_FILE_SIZE_BYTES,
  MAX_PAGE_COUNT,
} from '@lambdas/ingestion/edi-parser';

// ─── Test EDI 835 Content ───────────────────────────────────────────────────

const SAMPLE_EDI_835 = [
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
  'GS*HP*SENDER*RECEIVER*20230101*1200*1*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*I*150.00*C*ACH*CTX*01*999999999*DA*123456789*1234567890**01*999999999*DA*123456789*20230115~',
  'TRN*1*12345*1234567890~',
  'DTM*405*20230115~',
  'N1*PR*ACME INSURANCE*XV*12345~',
  'N1*PE*PROVIDER CLINIC*XX*1234567890~',
  'CLP*CLM123456*1*500.00*350.00*0*12*PAT789012~',
  'CAS*CO*45*100.00*253*50.00~',
  'DTM*232*20230101~',
  'DTM*233*20230115~',
  'SE*12*0001~',
  'GE*1*1~',
  'IEA*1*000000001~',
].join('');

const SAMPLE_EDI_277 = [
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230201*0800*^*00501*000000002*0*P*:~',
  'GS*HN*SENDER*RECEIVER*20230201*0800*2*X*005010X212~',
  'ST*277*0001~',
  'BHT*0010*08*REF123*20230201*0800~',
  'N1*PR*BLUE CROSS*XV*BC001~',
  'N1*IL*JOHN DOE*MI*PAT456~',
  'TRN*2*CLM987654*ORIGREF~',
  'STC*A1:20:PR*20230201*500.00~',
  'REF*EJ*CLM987654~',
  'SE*9*0001~',
  'GE*1*2~',
  'IEA*1*000000002~',
].join('');

// ─── Format Detection Tests ─────────────────────────────────────────────────

describe('detectEDIFormat', () => {
  it('should detect EDI 835 format', () => {
    expect(detectEDIFormat(SAMPLE_EDI_835)).toBe('edi_835');
  });

  it('should detect EDI 277 format', () => {
    expect(detectEDIFormat(SAMPLE_EDI_277)).toBe('edi_277');
  });

  it('should return null for unrecognized format', () => {
    const unknownContent = 'ISA*00*~GS*XX*~ST*999*0001~SE*3*0001~GE*1*1~IEA*1*1~';
    expect(detectEDIFormat(unknownContent)).toBeNull();
  });

  it('should return null for empty content', () => {
    expect(detectEDIFormat('')).toBeNull();
  });
});

// ─── Delimiter Detection Tests ──────────────────────────────────────────────

describe('detectDelimiters', () => {
  it('should detect standard delimiters from ISA segment', () => {
    const delimiters = detectDelimiters(SAMPLE_EDI_835);
    expect(delimiters.element).toBe('*');
    expect(delimiters.subElement).toBe(':');
    expect(delimiters.segment).toBe('~');
  });

  it('should return defaults for content without ISA', () => {
    const delimiters = detectDelimiters('ST*835*0001~CLP*123*1*500~');
    expect(delimiters.element).toBe('*');
    expect(delimiters.subElement).toBe(':');
    expect(delimiters.segment).toBe('~');
  });
});

// ─── Segment Splitting Tests ────────────────────────────────────────────────

describe('splitSegments', () => {
  it('should split content into segments', () => {
    const segments = splitSegments('ST*835*0001~CLP*123*1~SE*2*0001~');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe('ST*835*0001');
    expect(segments[1]).toBe('CLP*123*1');
    expect(segments[2]).toBe('SE*2*0001');
  });

  it('should handle whitespace between segments', () => {
    const segments = splitSegments('ST*835*0001~\n  CLP*123*1~\n  SE*2*0001~');
    expect(segments).toHaveLength(3);
  });

  it('should filter empty segments', () => {
    const segments = splitSegments('ST*835*0001~~CLP*123~');
    expect(segments).toHaveLength(2);
  });
});

describe('splitElements', () => {
  it('should split segment into elements', () => {
    const elements = splitElements('CLP*CLM123*1*500.00*350.00*0*12*PAT789');
    expect(elements[0]).toBe('CLP');
    expect(elements[1]).toBe('CLM123');
    expect(elements[3]).toBe('500.00');
    expect(elements[4]).toBe('350.00');
    expect(elements[7]).toBe('PAT789');
  });
});

describe('splitSubElements', () => {
  it('should split composite element into sub-elements', () => {
    const subElements = splitSubElements('A1:20:PR');
    expect(subElements).toEqual(['A1', '20', 'PR']);
  });

  it('should handle single value (no sub-elements)', () => {
    const subElements = splitSubElements('A1');
    expect(subElements).toEqual(['A1']);
  });
});

// ─── Date Conversion Tests ──────────────────────────────────────────────────

describe('convertEDIDate', () => {
  it('should convert CCYYMMDD to ISO 8601', () => {
    expect(convertEDIDate('20230115')).toBe('2023-01-15');
  });

  it('should handle first day of year', () => {
    expect(convertEDIDate('20230101')).toBe('2023-01-01');
  });

  it('should handle last day of year', () => {
    expect(convertEDIDate('20231231')).toBe('2023-12-31');
  });

  it('should return null for invalid date length', () => {
    expect(convertEDIDate('2023011')).toBeNull();
    expect(convertEDIDate('202301150')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(convertEDIDate('')).toBeNull();
  });

  it('should return null for invalid date values', () => {
    expect(convertEDIDate('20231301')).toBeNull(); // month 13
    expect(convertEDIDate('20230132')).toBeNull(); // day 32
  });
});

// ─── EDI 835 Parsing Tests ──────────────────────────────────────────────────

describe('parseEDI835', () => {
  it('should extract claim_id from CLP01', () => {
    const result = parseEDI835(SAMPLE_EDI_835);
    expect(result.claim_id).toBe('CLM123456');
  });

  it('should extract patient_id from CLP07', () => {
    const result = parseEDI835(SAMPLE_EDI_835);
    expect(result.patient_id).toBe('PAT789012');
  });

  it('should extract payer_id from N1*PR', () => {
    const result = parseEDI835(SAMPLE_EDI_835);
    expect(result.payer_id).toBe('12345');
  });

  it('should extract denial_date from DTM*232', () => {
    const result = parseEDI835(SAMPLE_EDI_835);
    expect(result.denial_date).toBe('2023-01-01');
  });

  it('should calculate denied_amount as charged - paid', () => {
    const result = parseEDI835(SAMPLE_EDI_835);
    // 500.00 - 350.00 = 150.00
    expect(result.denied_amount).toBe(150.00);
  });

  it('should extract adjustment reason codes from CAS segments', () => {
    const result = parseEDI835(SAMPLE_EDI_835);
    expect(result.adjustment_reason_codes).toHaveLength(2);
    expect(result.adjustment_reason_codes[0]).toEqual({
      group_code: 'CO',
      reason_code: '45',
      amount: 100.00,
    });
    expect(result.adjustment_reason_codes[1]).toEqual({
      group_code: 'CO',
      reason_code: '253',
      amount: 50.00,
    });
  });

  it('should build raw_denial_reason_text from adjustment codes', () => {
    const result = parseEDI835(SAMPLE_EDI_835);
    expect(result.raw_denial_reason_text).toBe('CO-45: $100.00; CO-253: $50.00');
  });

  it('should handle missing CLP segment gracefully', () => {
    const content = 'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~ST*835*0001~N1*PR*PAYER*XV*P001~SE*3*0001~';
    const result = parseEDI835(content);
    expect(result.claim_id).toBeNull();
    expect(result.patient_id).toBeNull();
    expect(result.denied_amount).toBeNull();
  });

  it('should handle multiple CAS segments', () => {
    const content = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
      'ST*835*0001~',
      'CLP*CLM001*1*1000.00*700.00*0*12*PAT001~',
      'CAS*CO*45*100.00~',
      'CAS*PR*1*150.00*2*50.00~',
      'SE*5*0001~',
    ].join('');

    const result = parseEDI835(content);
    expect(result.adjustment_reason_codes).toHaveLength(3);
    expect(result.adjustment_reason_codes[0].group_code).toBe('CO');
    expect(result.adjustment_reason_codes[1].group_code).toBe('PR');
    expect(result.adjustment_reason_codes[1].reason_code).toBe('1');
    expect(result.adjustment_reason_codes[2].group_code).toBe('PR');
    expect(result.adjustment_reason_codes[2].reason_code).toBe('2');
  });
});

// ─── EDI 277 Parsing Tests ──────────────────────────────────────────────────

describe('parseEDI277', () => {
  it('should extract claim_id from REF*EJ', () => {
    const result = parseEDI277(SAMPLE_EDI_277);
    expect(result.claim_id).toBe('CLM987654');
  });

  it('should extract status_category_code from STC01-1', () => {
    const result = parseEDI277(SAMPLE_EDI_277);
    expect(result.status_category_code).toBe('A1');
  });

  it('should extract status_code from STC01-2', () => {
    const result = parseEDI277(SAMPLE_EDI_277);
    expect(result.status_code).toBe('20');
  });

  it('should extract payer_id from N1*PR', () => {
    const result = parseEDI277(SAMPLE_EDI_277);
    expect(result.payer_id).toBe('BC001');
  });

  it('should extract patient_id from N1*IL', () => {
    const result = parseEDI277(SAMPLE_EDI_277);
    expect(result.patient_id).toBe('PAT456');
  });

  it('should build raw_denial_reason_text from status codes', () => {
    const result = parseEDI277(SAMPLE_EDI_277);
    expect(result.raw_denial_reason_text).toBe('Status Category: A1, Status Code: 20');
  });

  it('should handle TRN-based claim_id when REF is absent', () => {
    const content = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230201*0800*^*00501*000000002*0*P*:~',
      'ST*277*0001~',
      'TRN*2*TRNCLM001*ORIGREF~',
      'STC*B2:15:PR*20230201~',
      'SE*4*0001~',
    ].join('');

    const result = parseEDI277(content);
    expect(result.claim_id).toBe('TRNCLM001');
  });

  it('should handle missing STC segment', () => {
    const content = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230201*0800*^*00501*000000002*0*P*:~',
      'ST*277*0001~',
      'TRN*2*CLM001*REF~',
      'SE*3*0001~',
    ].join('');

    const result = parseEDI277(content);
    expect(result.claim_id).toBe('CLM001');
    expect(result.status_category_code).toBeNull();
    expect(result.status_code).toBeNull();
  });

  it('should prefer REF*EJ over TRN for claim_id', () => {
    const content = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230201*0800*^*00501*000000002*0*P*:~',
      'ST*277*0001~',
      'TRN*2*TRN_ID*REF~',
      'REF*EJ*REF_ID~',
      'STC*A1:10*20230201~',
      'SE*5*0001~',
    ].join('');

    const result = parseEDI277(content);
    // REF*EJ should override TRN
    expect(result.claim_id).toBe('REF_ID');
  });
});

// ─── Main parseEDI Function Tests ───────────────────────────────────────────

describe('parseEDI', () => {
  it('should successfully parse a valid EDI 835', () => {
    const result = parseEDI(SAMPLE_EDI_835);
    expect(result.success).toBe(true);
    expect(result.source_format).toBe('edi_835');
    expect(result.errors).toHaveLength(0);
  });

  it('should successfully parse a valid EDI 277', () => {
    const result = parseEDI(SAMPLE_EDI_277);
    expect(result.success).toBe(true);
    expect(result.source_format).toBe('edi_277');
    expect(result.errors).toHaveLength(0);
  });

  it('should report errors for unrecognized format', () => {
    const result = parseEDI('ST*999*0001~SE*1*0001~');
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Unable to detect EDI format');
  });

  it('should report errors for missing mandatory fields in 835', () => {
    const content = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
      'ST*835*0001~',
      'SE*2*0001~',
    ].join('');

    const result = parseEDI(content);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('claim_id'))).toBe(true);
  });

  it('should report errors for missing mandatory fields in 277', () => {
    const content = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230201*0800*^*00501*000000002*0*P*:~',
      'ST*277*0001~',
      'SE*2*0001~',
    ].join('');

    const result = parseEDI(content);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('claim_id'))).toBe(true);
    expect(result.errors.some((e) => e.includes('status_category_code'))).toBe(true);
  });

  it('should include transaction count in result', () => {
    const result = parseEDI(SAMPLE_EDI_835);
    expect(result.transaction_count).toBe(1);
  });
});

// ─── File Size and Page Count Validation Tests ──────────────────────────────

describe('validateFileLimits', () => {
  it('should pass for content within limits', () => {
    const result = validateFileLimits(SAMPLE_EDI_835);
    expect(result.valid).toBe(true);
    expect(result.fileSize).toBeGreaterThan(0);
    expect(result.transactionCount).toBe(1);
  });

  it('should fail for content exceeding 50 MB', () => {
    // Create content that exceeds 50 MB
    const largeContent = 'X'.repeat(MAX_FILE_SIZE_BYTES + 1);
    const result = validateFileLimits(largeContent);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('50 MB');
  });

  it('should fail for content with more than 100 transaction sets', () => {
    // Create content with 101 ST segments
    const transactions = Array.from({ length: 101 }, (_, i) =>
      `ST*835*${String(i).padStart(4, '0')}~CLP*CLM${i}*1*100*50~SE*2*${String(i).padStart(4, '0')}~`
    ).join('');
    const content = `ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~GS*HP*S*R*20230101*1200*1*X*005010~${transactions}GE*1*1~IEA*1*000000001~`;

    const result = validateFileLimits(content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('100');
    expect(result.transactionCount).toBe(101);
  });

  it('should pass for exactly 100 transaction sets', () => {
    const transactions = Array.from({ length: 100 }, (_, i) =>
      `ST*835*${String(i).padStart(4, '0')}~SE*1*${String(i).padStart(4, '0')}~`
    ).join('');
    const content = `ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~${transactions}IEA*1*000000001~`;

    const result = validateFileLimits(content);
    expect(result.valid).toBe(true);
    expect(result.transactionCount).toBe(100);
  });
});

// ─── Deduplication Key Building Tests ───────────────────────────────────────

describe('buildDeduplicationKey', () => {
  it('should build correct PK and SK for EDI 835', () => {
    const key = buildDeduplicationKey('tenant-001', 'CLM123', 'edi_835');
    expect(key.PK).toBe('TENANT#tenant-001');
    expect(key.SK).toBe('DENIAL#CLM123#edi_835');
    expect(key.tableName).toBe('DenialAppeals');
  });

  it('should build correct PK and SK for EDI 277', () => {
    const key = buildDeduplicationKey('tenant-002', 'CLM456', 'edi_277');
    expect(key.PK).toBe('TENANT#tenant-002');
    expect(key.SK).toBe('DENIAL#CLM456#edi_277');
    expect(key.tableName).toBe('DenialAppeals');
  });

  it('should produce different keys for same claim with different formats', () => {
    const key835 = buildDeduplicationKey('t1', 'CLM001', 'edi_835');
    const key277 = buildDeduplicationKey('t1', 'CLM001', 'edi_277');
    expect(key835.SK).not.toBe(key277.SK);
  });
});
