/**
 * Unit tests for the Textract document processor.
 */

import { describe, it, expect } from 'vitest';
import {
  extractTextFromBlocks,
  extractFieldsFromText,
  extractClaimId,
  extractPatientId,
  extractPayerId,
  extractDenialDate,
  extractDeniedAmount,
  extractDenialReason,
  normalizeDateToISO8601,
  buildAnalyzeDocumentInput,
  type TextractProcessorInput,
} from '../../../src/lambdas/ingestion/textract-processor';
import type { Block } from '@aws-sdk/client-textract';

// ─── extractTextFromBlocks ──────────────────────────────────────────────────

describe('extractTextFromBlocks', () => {
  it('should concatenate LINE blocks into text', () => {
    const blocks: Block[] = [
      { BlockType: 'LINE', Text: 'First line', Page: 1 },
      { BlockType: 'LINE', Text: 'Second line', Page: 1 },
      { BlockType: 'LINE', Text: 'Third line', Page: 2 },
    ];

    const result = extractTextFromBlocks(blocks);
    expect(result.text).toBe('First line\nSecond line\nThird line');
    expect(result.pageCount).toBe(2);
  });

  it('should ignore non-LINE blocks', () => {
    const blocks: Block[] = [
      { BlockType: 'PAGE', Page: 1 },
      { BlockType: 'LINE', Text: 'Only line', Page: 1 },
      { BlockType: 'WORD', Text: 'word', Page: 1 },
      { BlockType: 'TABLE', Page: 1 },
    ];

    const result = extractTextFromBlocks(blocks);
    expect(result.text).toBe('Only line');
    expect(result.pageCount).toBe(1);
  });

  it('should return empty text for empty blocks array', () => {
    const result = extractTextFromBlocks([]);
    expect(result.text).toBe('');
    expect(result.pageCount).toBe(1);
  });

  it('should handle blocks without Page property', () => {
    const blocks: Block[] = [
      { BlockType: 'LINE', Text: 'No page info' },
    ];

    const result = extractTextFromBlocks(blocks);
    expect(result.text).toBe('No page info');
    expect(result.pageCount).toBe(1);
  });
});

// ─── extractClaimId ─────────────────────────────────────────────────────────

describe('extractClaimId', () => {
  it('should extract claim ID with "Claim #" prefix', () => {
    const result = extractClaimId('Claim # ABC-12345');
    expect(result.value).toBe('ABC-12345');
    expect(result.confidence).toBe('high');
  });

  it('should extract claim ID with "Claim Number:" prefix', () => {
    const result = extractClaimId('Claim Number: CLM987654');
    expect(result.value).toBe('CLM987654');
    expect(result.confidence).toBe('high');
  });

  it('should extract claim ID with "ICN" prefix', () => {
    const result = extractClaimId('ICN: 1234567890123');
    expect(result.value).toBe('1234567890123');
    expect(result.confidence).toBe('high');
  });

  it('should extract claim ID with "Claim ID" prefix', () => {
    const result = extractClaimId('Claim ID: WPS-2024-001');
    expect(result.value).toBe('WPS-2024-001');
    expect(result.confidence).toBe('high');
  });

  it('should return null when no claim ID pattern matches', () => {
    const result = extractClaimId('This document has no claim information');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ─── extractPatientId ───────────────────────────────────────────────────────

describe('extractPatientId', () => {
  it('should extract member ID', () => {
    const result = extractPatientId('Member ID: MEM-456789');
    expect(result.value).toBe('MEM-456789');
    expect(result.confidence).toBe('high');
  });

  it('should extract patient ID', () => {
    const result = extractPatientId('Patient ID: PAT123456');
    expect(result.value).toBe('PAT123456');
    expect(result.confidence).toBe('high');
  });

  it('should extract subscriber ID', () => {
    const result = extractPatientId('Subscriber ID: SUB-789012');
    expect(result.value).toBe('SUB-789012');
    expect(result.confidence).toBe('high');
  });

  it('should return null when no patient ID found', () => {
    const result = extractPatientId('No patient info here');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ─── extractPayerId ─────────────────────────────────────────────────────────

describe('extractPayerId', () => {
  it('should extract insurance company name', () => {
    const result = extractPayerId('Insurance Company: Blue Cross Blue Shield');
    expect(result.value).toBe('Blue Cross Blue Shield');
    expect(result.confidence).toBe('high');
  });

  it('should extract plan name', () => {
    const result = extractPayerId('Plan Name: Aetna PPO Gold');
    expect(result.value).toBe('Aetna PPO Gold');
    expect(result.confidence).toBe('high');
  });

  it('should extract payer ID', () => {
    const result = extractPayerId('Payer ID: BCBS-FL-001');
    expect(result.value).toBe('BCBS-FL-001');
    expect(result.confidence).toBe('high');
  });

  it('should return null when no payer info found', () => {
    const result = extractPayerId('No payer information');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ─── extractDenialDate ──────────────────────────────────────────────────────

describe('extractDenialDate', () => {
  it('should extract date in MM/DD/YYYY format', () => {
    const result = extractDenialDate('Date of Denial: 03/15/2024');
    expect(result.value).toBe('2024-03-15');
    expect(result.confidence).toBe('high');
  });

  it('should extract date in MM-DD-YYYY format', () => {
    const result = extractDenialDate('Determination Date: 12-01-2023');
    expect(result.value).toBe('2023-12-01');
    expect(result.confidence).toBe('high');
  });

  it('should extract date in YYYY-MM-DD format', () => {
    const result = extractDenialDate('Denial Date: 2024-06-20');
    expect(result.value).toBe('2024-06-20');
    expect(result.confidence).toBe('high');
  });

  it('should extract date in "Month DD, YYYY" format', () => {
    const result = extractDenialDate('Date of Denial: January 15, 2024');
    expect(result.value).toBe('2024-01-15');
    expect(result.confidence).toBe('high');
  });

  it('should return null when no date found', () => {
    const result = extractDenialDate('No date information here');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ─── extractDeniedAmount ────────────────────────────────────────────────────

describe('extractDeniedAmount', () => {
  it('should extract amount after "denied" keyword', () => {
    const result = extractDeniedAmount('The claim was denied $1,234.56');
    expect(result.value).toBe(1234.56);
    expect(result.confidence).toBe('high');
  });

  it('should extract amount with "Amount Denied" label', () => {
    const result = extractDeniedAmount('Amount Denied: $500.00');
    expect(result.value).toBe(500.00);
    expect(result.confidence).toBe('high');
  });

  it('should extract amount with "not covered" keyword', () => {
    const result = extractDeniedAmount('not covered amount: $2,500.75');
    expect(result.value).toBe(2500.75);
    expect(result.confidence).toBe('high');
  });

  it('should handle amounts without decimal places', () => {
    const result = extractDeniedAmount('Denied Amount: $1000');
    expect(result.value).toBe(1000);
    expect(result.confidence).toBe('high');
  });

  it('should return null when no amount found', () => {
    const result = extractDeniedAmount('No amount information');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ─── extractDenialReason ────────────────────────────────────────────────────

describe('extractDenialReason', () => {
  it('should extract reason with "Reason for Denial" label', () => {
    const result = extractDenialReason(
      'Reason for Denial: Services not medically necessary based on clinical documentation provided.'
    );
    expect(result.value).toContain('Services not medically necessary');
    expect(result.confidence).toBe('high');
  });

  it('should extract reason with "claim was denied because" pattern', () => {
    const result = extractDenialReason(
      'This claim was denied because the procedure requires prior authorization.'
    );
    expect(result.value).toContain('the procedure requires prior authorization');
    expect(result.confidence).toBe('high');
  });

  it('should return null when no denial reason found', () => {
    const result = extractDenialReason('No reason information here');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ─── normalizeDateToISO8601 ─────────────────────────────────────────────────

describe('normalizeDateToISO8601', () => {
  it('should normalize MM/DD/YYYY', () => {
    expect(normalizeDateToISO8601('03/15/2024')).toBe('2024-03-15');
  });

  it('should normalize M/D/YYYY', () => {
    expect(normalizeDateToISO8601('3/5/2024')).toBe('2024-03-05');
  });

  it('should normalize MM-DD-YYYY', () => {
    expect(normalizeDateToISO8601('12-01-2023')).toBe('2023-12-01');
  });

  it('should normalize MM/DD/YY (2000s)', () => {
    expect(normalizeDateToISO8601('03/15/24')).toBe('2024-03-15');
  });

  it('should normalize MM/DD/YY (1900s)', () => {
    expect(normalizeDateToISO8601('03/15/99')).toBe('1999-03-15');
  });

  it('should normalize YYYY-MM-DD', () => {
    expect(normalizeDateToISO8601('2024-03-15')).toBe('2024-03-15');
  });

  it('should normalize YYYY/MM/DD', () => {
    expect(normalizeDateToISO8601('2024/03/15')).toBe('2024-03-15');
  });

  it('should normalize "Month DD, YYYY"', () => {
    expect(normalizeDateToISO8601('January 15, 2024')).toBe('2024-01-15');
  });

  it('should normalize "Month DD YYYY" (no comma)', () => {
    expect(normalizeDateToISO8601('March 5 2024')).toBe('2024-03-05');
  });

  it('should return null for unrecognized formats', () => {
    expect(normalizeDateToISO8601('15th of March 2024')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(normalizeDateToISO8601('')).toBeNull();
  });
});

// ─── buildAnalyzeDocumentInput ──────────────────────────────────────────────

describe('buildAnalyzeDocumentInput', () => {
  it('should build S3-based input when no bytes provided', () => {
    const input: TextractProcessorInput = {
      s3Bucket: 'my-bucket',
      s3Key: 'documents/denial.pdf',
      format: 'pdf',
    };

    const result = buildAnalyzeDocumentInput(input);
    expect(result.Document?.S3Object?.Bucket).toBe('my-bucket');
    expect(result.Document?.S3Object?.Name).toBe('documents/denial.pdf');
    expect(result.FeatureTypes).toContain('FORMS');
    expect(result.FeatureTypes).toContain('TABLES');
  });

  it('should build bytes-based input when documentBytes provided', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const input: TextractProcessorInput = {
      s3Bucket: 'my-bucket',
      s3Key: 'documents/denial.png',
      format: 'png',
      documentBytes: bytes,
    };

    const result = buildAnalyzeDocumentInput(input);
    expect(result.Document?.Bytes).toBe(bytes);
    expect(result.Document?.S3Object).toBeUndefined();
    expect(result.FeatureTypes).toContain('FORMS');
    expect(result.FeatureTypes).toContain('TABLES');
  });
});

// ─── extractFieldsFromText (integration of all extractors) ──────────────────

describe('extractFieldsFromText', () => {
  it('should extract all fields from a complete denial document', () => {
    const text = `
DENIAL OF CLAIM NOTIFICATION

Insurance Company: United Healthcare
Member ID: UHC-123456789
Claim # CLM-2024-00567
Date of Denial: 03/15/2024

Dear Provider,

This claim was denied because the procedure requires prior authorization which was not obtained.

Amount Denied: $3,450.00

Reason for Denial: Prior authorization was not obtained for the requested procedure. Please submit authorization documentation.
    `.trim();

    const result = extractFieldsFromText(text, 1);

    expect(result.claim_id.value).toBe('CLM-2024-00567');
    expect(result.patient_id.value).toBe('UHC-123456789');
    expect(result.payer_id.value).toBe('United Healthcare');
    expect(result.denial_date.value).toBe('2024-03-15');
    expect(result.denied_amount.value).toBe(3450.00);
    expect(result.denial_reason.value).toContain('Prior authorization');
    expect(result.raw_text).toBe(text);
    expect(result.page_count).toBe(1);
  });

  it('should handle document with missing fields gracefully', () => {
    const text = 'This is a document with no recognizable denial fields.';

    const result = extractFieldsFromText(text, 1);

    expect(result.claim_id.value).toBeNull();
    expect(result.patient_id.value).toBeNull();
    expect(result.payer_id.value).toBeNull();
    expect(result.denial_date.value).toBeNull();
    expect(result.denied_amount.value).toBeNull();
    expect(result.denial_reason.value).toBeNull();
    expect(result.raw_text).toBe(text);
  });
});
